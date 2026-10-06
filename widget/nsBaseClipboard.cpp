/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsBaseClipboard.h"

#include "ContentAnalysis.h"
#include "mozilla/AutoRestore.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/Components.h"
#include "mozilla/ErrorResult.h"
#include "mozilla/RefPtr.h"
#include "mozilla/Services.h"
#include "mozilla/StaticPrefs_browser.h"
#include "mozilla/StaticPrefs_clipboard.h"
#include "mozilla/StaticPrefs_dom.h"
#include "mozilla/StaticPrefs_widget.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/dom/BindingUtils.h"
#include "mozilla/dom/CanonicalBrowsingContext.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/MimeType.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/dom/PromiseNativeHandler.h"
#include "mozilla/dom/WindowContext.h"
#include "mozilla/dom/WindowGlobalParent.h"
#include "mozilla/intl/Localization.h"
#include "nsArrayUtils.h"
#include "nsContentUtils.h"
#include "nsError.h"
#include "nsFocusManager.h"
#include "nsIClipboardOwner.h"
#include "nsIObserver.h"
#include "nsIObserverService.h"
#include "nsIPrincipal.h"
#include "nsIPromptService.h"
#include "nsISupportsPrimitives.h"
#include "nsXPCOM.h"

using mozilla::GenericPromise;
using mozilla::LogLevel;
using mozilla::UniquePtr;
using mozilla::dom::BrowsingContext;
using mozilla::dom::CanonicalBrowsingContext;
using mozilla::dom::ClipboardCapabilities;
using mozilla::dom::Document;

mozilla::LazyLogModule gWidgetClipboardLog("WidgetClipboard");

static const int32_t kGetAvailableFlavorsRetryCount = 5;

namespace {

struct ClipboardGetRequest {
  ClipboardGetRequest(const nsTArray<nsCString>& aFlavorList,
                      nsIClipboardGetDataSnapshotCallback* aCallback)
      : mFlavorList(aFlavorList.Clone()), mCallback(aCallback) {}

  const nsTArray<nsCString> mFlavorList;
  const nsCOMPtr<nsIClipboardGetDataSnapshotCallback> mCallback;
};

class UserConfirmationRequest final
    : public mozilla::dom::PromiseNativeHandler {
 public:
  NS_DECL_CYCLE_COLLECTING_ISUPPORTS
  NS_DECL_CYCLE_COLLECTION_CLASS(UserConfirmationRequest)

  UserConfirmationRequest(nsIClipboard::ClipboardType aClipboardType,
                          Document* aRequestingChromeDocument,
                          nsIPrincipal* aRequestingPrincipal,
                          nsBaseClipboard* aClipboard,
                          mozilla::dom::WindowContext* aRequestingWindowContext)
      : mClipboardType(aClipboardType),
        mRequestingChromeDocument(aRequestingChromeDocument),
        mRequestingPrincipal(aRequestingPrincipal),
        mClipboard(aClipboard),
        mRequestingWindowContext(aRequestingWindowContext) {
    MOZ_ASSERT(
        mClipboard->nsIClipboard::IsClipboardTypeSupported(aClipboardType));
  }

  void ResolvedCallback(JSContext* aCx, JS::Handle<JS::Value> aValue,
                        mozilla::ErrorResult& aRv) override;

  void RejectedCallback(JSContext* aCx, JS::Handle<JS::Value> aValue,
                        mozilla::ErrorResult& aRv) override;

  bool IsEqual(nsIClipboard::ClipboardType aClipboardType,
               Document* aRequestingChromeDocument,
               nsIPrincipal* aRequestingPrincipal,
               mozilla::dom::WindowContext* aRequestingWindowContext) const {
    if (!(ClipboardType() == aClipboardType &&
          RequestingChromeDocument() == aRequestingChromeDocument &&
          RequestingPrincipal()->Equals(aRequestingPrincipal) &&
          (mRequestingWindowContext && aRequestingWindowContext))) {
      return false;
    }
    // Only check requesting window contexts if content analysis is active
    nsCOMPtr<nsIContentAnalysis> contentAnalysis =
        mozilla::components::nsIContentAnalysis::Service();
    if (!contentAnalysis) {
      return false;
    }

    bool contentAnalysisIsActive;
    nsresult rv = contentAnalysis->GetIsActive(&contentAnalysisIsActive);
    if (MOZ_LIKELY(NS_FAILED(rv) || !contentAnalysisIsActive)) {
      return true;
    }
    return mRequestingWindowContext->Id() == aRequestingWindowContext->Id();
  }

  nsIClipboard::ClipboardType ClipboardType() const { return mClipboardType; }

  Document* RequestingChromeDocument() const {
    return mRequestingChromeDocument;
  }

  nsIPrincipal* RequestingPrincipal() const { return mRequestingPrincipal; }

  void AddClipboardGetRequest(const nsTArray<nsCString>& aFlavorList,
                              nsIClipboardGetDataSnapshotCallback* aCallback) {
    MOZ_ASSERT(!aFlavorList.IsEmpty());
    MOZ_ASSERT(aCallback);
    mPendingClipboardGetRequests.AppendElement(
        mozilla::MakeUnique<ClipboardGetRequest>(aFlavorList, aCallback));
  }

  void RejectPendingClipboardGetRequests(nsresult aError) {
    MOZ_ASSERT(NS_FAILED(aError));
    auto requests = std::move(mPendingClipboardGetRequests);
    for (const auto& request : requests) {
      MOZ_ASSERT(request);
      MOZ_ASSERT(request->mCallback);
      request->mCallback->OnError(aError);
    }
  }

  void ProcessPendingClipboardGetRequests() {
    auto requests = std::move(mPendingClipboardGetRequests);
    for (const auto& request : requests) {
      MOZ_ASSERT(request);
      MOZ_ASSERT(!request->mFlavorList.IsEmpty());
      MOZ_ASSERT(request->mCallback);
      mClipboard->GetDataSnapshotInternal(request->mFlavorList, mClipboardType,
                                          mRequestingWindowContext,
                                          request->mCallback);
    }
  }

  nsTArray<UniquePtr<ClipboardGetRequest>>& GetPendingClipboardGetRequests() {
    return mPendingClipboardGetRequests;
  }

 private:
  ~UserConfirmationRequest() = default;

  const nsIClipboard::ClipboardType mClipboardType;
  RefPtr<Document> mRequestingChromeDocument;
  const nsCOMPtr<nsIPrincipal> mRequestingPrincipal;
  const RefPtr<nsBaseClipboard> mClipboard;
  const RefPtr<mozilla::dom::WindowContext> mRequestingWindowContext;
  // Track the pending read requests that wait for user confirmation.
  nsTArray<UniquePtr<ClipboardGetRequest>> mPendingClipboardGetRequests;
};

NS_IMPL_CYCLE_COLLECTION(UserConfirmationRequest, mRequestingChromeDocument)

NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(UserConfirmationRequest)
  NS_INTERFACE_MAP_ENTRY(nsISupports)
NS_INTERFACE_MAP_END

NS_IMPL_CYCLE_COLLECTING_ADDREF(UserConfirmationRequest)
NS_IMPL_CYCLE_COLLECTING_RELEASE(UserConfirmationRequest)

static mozilla::StaticRefPtr<UserConfirmationRequest> sUserConfirmationRequest;

void UserConfirmationRequest::ResolvedCallback(JSContext* aCx,
                                               JS::Handle<JS::Value> aValue,
                                               mozilla::ErrorResult& aRv) {
  MOZ_DIAGNOSTIC_ASSERT(sUserConfirmationRequest == this);
  sUserConfirmationRequest = nullptr;

  JS::Rooted<JSObject*> detailObj(aCx, &aValue.toObject());
  nsCOMPtr<nsIPropertyBag2> propBag;
  nsresult rv = mozilla::dom::UnwrapArg<nsIPropertyBag2>(
      aCx, detailObj, getter_AddRefs(propBag));
  if (NS_FAILED(rv)) {
    RejectPendingClipboardGetRequests(rv);
    return;
  }

  bool result = false;
  rv = propBag->GetPropertyAsBool(u"ok"_ns, &result);
  if (NS_FAILED(rv)) {
    RejectPendingClipboardGetRequests(rv);
    return;
  }

  if (!result) {
    RejectPendingClipboardGetRequests(NS_ERROR_DOM_NOT_ALLOWED_ERR);
    return;
  }

  ProcessPendingClipboardGetRequests();
}

void UserConfirmationRequest::RejectedCallback(JSContext* aCx,
                                               JS::Handle<JS::Value> aValue,
                                               mozilla::ErrorResult& aRv) {
  MOZ_DIAGNOSTIC_ASSERT(sUserConfirmationRequest == this);
  sUserConfirmationRequest = nullptr;
  RejectPendingClipboardGetRequests(NS_ERROR_FAILURE);
}

constexpr char kLastPrivateBrowsingContextExited[] = "last-pb-context-exited";

// Runs a callback when the last private window closes. Only the global
// clipboard cache ever holds local-only data, so one callback suffices.
class PrivateBrowsingExitObserver final : public nsIObserver {
 public:
  NS_DECL_ISUPPORTS

  using Callback = mozilla::MoveOnlyFunction<void()>;

  static PrivateBrowsingExitObserver* Get() {
    if (!sInstance) {
      sInstance = new PrivateBrowsingExitObserver();
      mozilla::ClearOnShutdown(&sInstance);
    }
    return sInstance;
  }
  static PrivateBrowsingExitObserver* GetIfExists() { return sInstance; }

  void Start(Callback&& aCallback) {
    nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
    if (!obs) {
      return;
    }
    if (!mCallback) {
      obs->AddObserver(this, kLastPrivateBrowsingContextExited, false);
    }
    mCallback = std::move(aCallback);
  }

  void Stop() {
    if (!mCallback) {
      return;
    }
    mCallback = nullptr;
    if (nsCOMPtr<nsIObserverService> obs =
            mozilla::services::GetObserverService()) {
      obs->RemoveObserver(this, kLastPrivateBrowsingContextExited);
    }
  }

  NS_IMETHOD Observe(nsISupports*, const char* aTopic,
                     const char16_t*) override {
    if (mCallback && !strcmp(aTopic, kLastPrivateBrowsingContextExited)) {
      // The callback is expected to call Stop(), so move it out first.
      Callback callback = std::move(mCallback);
      if (nsCOMPtr<nsIObserverService> obs =
              mozilla::services::GetObserverService()) {
        obs->RemoveObserver(this, kLastPrivateBrowsingContextExited);
      }
      callback();
    }
    return NS_OK;
  }

 private:
  ~PrivateBrowsingExitObserver() = default;

  Callback mCallback;
  static mozilla::StaticRefPtr<PrivateBrowsingExitObserver> sInstance;
};

mozilla::StaticRefPtr<PrivateBrowsingExitObserver>
    PrivateBrowsingExitObserver::sInstance;

NS_IMPL_ISUPPORTS(PrivateBrowsingExitObserver, nsIObserver)

}  // namespace

NS_IMPL_ISUPPORTS(nsBaseClipboard::AsyncSetClipboardData,
                  nsIAsyncSetClipboardData)

nsBaseClipboard::AsyncSetClipboardData::AsyncSetClipboardData(
    nsIClipboard::ClipboardType aClipboardType, nsBaseClipboard* aClipboard,
    mozilla::dom::WindowContext* aSettingWindowContext,
    nsIAsyncClipboardRequestCallback* aCallback)
    : mClipboardType(aClipboardType),
      mClipboard(aClipboard),
      mWindowContext(aSettingWindowContext),
      mCallback(aCallback) {
  MOZ_ASSERT(mClipboard);
  MOZ_ASSERT(
      mClipboard->nsIClipboard::IsClipboardTypeSupported(mClipboardType));
}

NS_IMETHODIMP
nsBaseClipboard::AsyncSetClipboardData::SetData(nsITransferable* aTransferable,
                                                nsIClipboardOwner* aOwner) {
  MOZ_CLIPBOARD_LOG("AsyncSetClipboardData::SetData (%p): clipboard=%d", this,
                    mClipboardType);

  if (!IsValid()) {
    return NS_ERROR_FAILURE;
  }

  if (MOZ_CLIPBOARD_LOG_ENABLED()) {
    nsTArray<nsCString> flavors;
    if (NS_SUCCEEDED(aTransferable->FlavorsTransferableCanImport(flavors))) {
      for (const auto& flavor : flavors) {
        MOZ_CLIPBOARD_LOG("    MIME %s", flavor.get());
      }
    }
  }

  MOZ_ASSERT(mClipboard);
  MOZ_ASSERT(
      mClipboard->nsIClipboard::IsClipboardTypeSupported(mClipboardType));
  RefPtr<AsyncSetClipboardData> selfPin(this);

  if (mClipboard->mPendingWriteRequests[mClipboardType] != this) {
    return NS_ERROR_IN_PROGRESS;
  }
  mClipboard->mPendingWriteRequests[mClipboardType] = nullptr;

  // The write may be held back for a content analysis copy check, so notify
  // from the completion rather than from the return value -- otherwise the
  // page's promise would resolve before the verdict was in.
  return mClipboard->SetDataImpl(
      aTransferable, aOwner, mClipboardType, mWindowContext,
      /* aCheckContentAnalysis */ true, [self = RefPtr{this}](nsresult aRv) {
        // Abort() may have already notified and invalidated us.
        if (self->IsValid()) {
          self->MaybeNotifyCallback(aRv);
        }
      });
}

NS_IMETHODIMP
nsBaseClipboard::AsyncSetClipboardData::Abort(nsresult aReason) {
  // Note: This may be called during destructor, so it should not attempt to
  // take a reference to mClipboard.

  if (!IsValid() || !NS_FAILED(aReason)) {
    return NS_ERROR_FAILURE;
  }

  MaybeNotifyCallback(aReason);
  return NS_OK;
}

void nsBaseClipboard::AsyncSetClipboardData::MaybeNotifyCallback(
    nsresult aResult) {
  // Note: This may be called during destructor, so it should not attempt to
  // take a reference to mClipboard.

  MOZ_ASSERT(IsValid());
  // Once the callback is notified, setData should not be allowed, so invalidate
  // this request.
  mClipboard = nullptr;
  if (nsCOMPtr<nsIAsyncClipboardRequestCallback> callback =
          mCallback.forget()) {
    callback->OnComplete(aResult);
  }
}

void nsBaseClipboard::RejectPendingAsyncSetDataRequestIfAny(
    ClipboardType aClipboardType) {
  MOZ_ASSERT(nsIClipboard::IsClipboardTypeSupported(aClipboardType));
  auto& request = mPendingWriteRequests[aClipboardType];
  if (request) {
    request->Abort(NS_ERROR_ABORT);
    request = nullptr;
  }
}

NS_IMETHODIMP nsBaseClipboard::AsyncSetData(
    ClipboardType aWhichClipboard,
    mozilla::dom::WindowContext* aSettingWindowContext,
    nsIAsyncClipboardRequestCallback* aCallback,
    nsIAsyncSetClipboardData** _retval) {
  MOZ_CLIPBOARD_LOG("%s: clipboard=%d", __FUNCTION__, aWhichClipboard);

  *_retval = nullptr;
  if (!nsIClipboard::IsClipboardTypeSupported(aWhichClipboard)) {
    MOZ_CLIPBOARD_LOG("%s: clipboard %d is not supported.", __FUNCTION__,
                      aWhichClipboard);
    return NS_ERROR_DOM_NOT_SUPPORTED_ERR;
  }

  // Reject existing pending AsyncSetData request if any.
  RejectPendingAsyncSetDataRequestIfAny(aWhichClipboard);

  // Create a new AsyncSetClipboardData.
  RefPtr<AsyncSetClipboardData> request =
      mozilla::MakeRefPtr<AsyncSetClipboardData>(
          aWhichClipboard, this, aSettingWindowContext, aCallback);
  mPendingWriteRequests[aWhichClipboard] = request;
  request.forget(_retval);
  return NS_OK;
}

nsBaseClipboard::nsBaseClipboard(const ClipboardCapabilities& aClipboardCaps)
    : mClipboardCaps(aClipboardCaps) {
  using mozilla::MakeUnique;
  // Initialize clipboard cache.
  mCaches[kGlobalClipboard] = MakeUnique<ClipboardCache>();
  if (mClipboardCaps.supportsSelectionClipboard()) {
    mCaches[kSelectionClipboard] = MakeUnique<ClipboardCache>();
  }
  if (mClipboardCaps.supportsFindClipboard()) {
    mCaches[kFindClipboard] = MakeUnique<ClipboardCache>();
  }
  if (mClipboardCaps.supportsSelectionCache()) {
    mCaches[kSelectionCache] = MakeUnique<ClipboardCache>();
  }
}

nsBaseClipboard::~nsBaseClipboard() {
  for (auto& request : mPendingWriteRequests) {
    if (request) {
      request->Abort(NS_ERROR_ABORT);
      request = nullptr;
    }
  }
  if (mPendingCopy) {
    mPendingCopy->Complete(NS_ERROR_ABORT);
    mPendingCopy = nullptr;
  }
}

NS_IMPL_ISUPPORTS(nsBaseClipboard, nsIClipboard)

/**
 * Sets the transferable object
 *
 */
NS_IMETHODIMP nsBaseClipboard::SetData(
    nsITransferable* aTransferable, nsIClipboardOwner* aOwner,
    ClipboardType aWhichClipboard,
    mozilla::dom::WindowContext* aWindowContext) {
  return SetDataImpl(aTransferable, aOwner, aWhichClipboard, aWindowContext,
                     /* aCheckContentAnalysis */ true);
}

void nsBaseClipboard::SetDataWithCompletion(
    nsITransferable* aTransferable, nsIClipboardOwner* aOwner,
    ClipboardType aWhichClipboard, mozilla::dom::WindowContext* aWindowContext,
    SetDataCompletion&& aCompletion) {
  MOZ_ASSERT(aCompletion);
  // SetDataImpl guarantees aCompletion runs exactly once, so the return value
  // is redundant.
  SetDataImpl(aTransferable, aOwner, aWhichClipboard, aWindowContext,
              /* aCheckContentAnalysis */ true, std::move(aCompletion));
}

bool nsBaseClipboard::NeedsCopyContentAnalysis(
    nsITransferable* aTransferable, ClipboardType aWhichClipboard,
    mozilla::dom::WindowContext* aWindowContext) {
  // Only the global clipboard is analyzed: on Linux the primary selection is
  // written on every text selection, which would flood the agent.
  if (aWhichClipboard != kGlobalClipboard || !aTransferable) {
    return false;
  }

  // MightBeActive() and the pref are fast paths for the common case; the
  // content analysis machinery checks both again.
  if (!nsIContentAnalysis::MightBeActive() ||
      !mozilla::StaticPrefs::
          browser_contentanalysis_interception_point_clipboard_copy_enabled()) {
    return false;
  }

  // Content analysis only cares about copies an outside webpage can see. A
  // null window context is a parent-process copy; chrome and parent-rendered
  // windows (the URL bar, about: pages) are exempt. ContentAnalysis's
  // GetFinalRequestList exempts these too, but recognizing them here keeps
  // such copies fully synchronous instead of deferring a write that was never
  // going to be analyzed.
  return aWindowContext && !aWindowContext->IsInProcess() &&
         aWindowContext->GetBrowsingContext() &&
         !aWindowContext->GetBrowsingContext()->IsChrome();
}

void nsBaseClipboard::CancelPendingCopy(ClipboardType aClipboardType,
                                        nsresult aReason) {
  if (aClipboardType == kGlobalClipboard) {
    if (RefPtr<PendingCopy> pendingCopy = std::move(mPendingCopy)) {
      MOZ_CLIPBOARD_LOG("%s: superseding deferred copy", __FUNCTION__);
      pendingCopy->Complete(aReason);
    }
  }
}

bool nsBaseClipboard::WriteCopyBlockedPlaceholder(
    ClipboardType aWhichClipboard) {
  return WriteCopyPlaceholder(
      aWhichClipboard, "contentanalysis-clipboard-copy-blocked-replacement"_ns);
}

bool nsBaseClipboard::WriteCopyWarnPlaceholder(ClipboardType aWhichClipboard) {
  return WriteCopyPlaceholder(
      aWhichClipboard, "contentanalysis-clipboard-copy-warn-replacement"_ns);
}

bool nsBaseClipboard::WriteCopyPlaceholder(ClipboardType aWhichClipboard,
                                           const nsACString& aL10nId) {
  // We replace the clipboard contents rather than leaving them alone: if we
  // left them, the user could copy blocked content and then the next paste
  // would paste whatever happened to be on the clipboard beforehand. Writing
  // (rather than emptying) also guarantees a new native sequence number, which
  // local-only cached data is keyed to. (on GTK, emptying a clipboard another
  // application owns changes nothing)
  nsAutoCString message;
  {
    mozilla::IgnoredErrorResult rv;
    nsTArray<nsCString> resIds = {
        "branding/brand.ftl"_ns,
        "toolkit/contentanalysis/contentanalysis.ftl"_ns};
    RefPtr<mozilla::intl::Localization> l10n =
        mozilla::intl::Localization::Create(resIds, /* aSync */ true);
    l10n->FormatValueSync(aL10nId, {}, message, rv);
  }
  if (message.IsEmpty()) {
    MOZ_CLIPBOARD_LOG("%s: could not load the placeholder string.",
                      __FUNCTION__);
    return false;
  }

  nsCOMPtr<nsITransferable> trans =
      do_CreateInstance("@mozilla.org/widget/transferable;1");
  nsCOMPtr<nsISupportsString> data =
      do_CreateInstance("@mozilla.org/supports-string;1");
  if (!trans || !data) {
    return false;
  }
  trans->Init(nullptr);
  if (NS_FAILED(trans->AddDataFlavor(kTextMime)) ||
      NS_FAILED(data->SetData(NS_ConvertUTF8toUTF16(message))) ||
      NS_FAILED(trans->SetTransferData(kTextMime, data))) {
    return false;
  }

  // No window context: this text is ours, not the page's, so it must not be
  // analyzed and must not be attributed to the copying window.
  return NS_SUCCEEDED(SetDataImpl(trans, nullptr /* aOwner */, aWhichClipboard,
                                  nullptr /* aWindowContext */,
                                  /* aCheckContentAnalysis */ false));
}

mozilla::Maybe<nsBaseClipboard::LocalCopyInfo>
nsBaseClipboard::GetLocalCopyInfo() {
  const auto* clipboardCache = GetClipboardCacheIfValid(kGlobalClipboard);
  return clipboardCache ? clipboardCache->GetLocalCopyInfo()
                        : mozilla::Nothing();
}

void nsBaseClipboard::OnCopyContentAnalysisResult(ClipboardType aWhichClipboard,
                                                  PendingCopy* aPendingCopy,
                                                  bool aAllowed) {
  MOZ_ASSERT(NS_IsMainThread());
  // We only analyze copies to the global clipboard
  MOZ_ASSERT(aWhichClipboard == kGlobalClipboard);

  if (mPendingCopy != aPendingCopy) {
#ifdef MOZ_ENTERPRISE
    // OnCopyContentAnalysisWarn() clears mPendingCopy, because in some sense
    // the copy isn't "pending" any more. So check for this case and update
    // the native clipboard with the user's answer.
    const auto& clipboardCache = mCaches[aWhichClipboard];
    if (auto localCopy = GetLocalCopyInfo();
        localCopy && localCopy->mState == LocalCopyState::eWarn &&
        localCopy->mTransferable == aPendingCopy->mTransferable) {
      nsCOMPtr<nsITransferable> trans = localCopy->mTransferable;
      nsCOMPtr<nsIClipboardOwner> owner =
          clipboardCache->GetLocalOnlyClipboardOwner();
      RefPtr<mozilla::dom::WindowContext> window =
          clipboardCache->GetLocalOnlySourceWindow();
      if (aAllowed) {
        // Committing replaces the local-only data with the committed copy.
        MOZ_CLIPBOARD_LOG("%s: user allowed warned copy, clipboard=%d",
                          __FUNCTION__, aWhichClipboard);
        SetDataImpl(trans, owner, aWhichClipboard, window,
                    /* aCheckContentAnalysis */ false);
      } else {
        // Denied: from here on it is an ordinary blocked copy.
        MOZ_CLIPBOARD_LOG("%s: user denied warned copy, clipboard=%d",
                          __FUNCTION__, aWhichClipboard);
        if (WriteCopyBlockedPlaceholder(aWhichClipboard)) {
          clipboardCache->UpdateLocalOnly(
              LocalCopyState::eBlocked, trans, owner,
              clipboardCache->GetSequenceNumber(), window);
        }
      }
      return;
    }
#endif
    // A write issued after this one already superseded it.  The newer write
    // wins regardless of which verdict came back first.
    MOZ_CLIPBOARD_LOG("%s: ignoring stale copy verdict, clipboard=%d",
                      __FUNCTION__, aWhichClipboard);
    aPendingCopy->Complete(NS_ERROR_ABORT);
    return;
  }

  RefPtr<PendingCopy> pendingCopy = std::move(mPendingCopy);

  if (!aAllowed) {
    MOZ_CLIPBOARD_LOG("%s: copy blocked by content analysis, clipboard=%d",
                      __FUNCTION__, aWhichClipboard);
    bool wrotePlaceholder = WriteCopyBlockedPlaceholder(aWhichClipboard);
#ifdef MOZ_ENTERPRISE
    // Keeping the blocked data for same-page paste is Enterprise-only. The
    // placeholder is what is on the native clipboard now, so the blocked data
    // is cached as local-only, keyed to the placeholder's sequence number.
    if (wrotePlaceholder &&
        mozilla::StaticPrefs::
            browser_contentanalysis_interception_point_clipboard_copy_keep_blocked_data_for_same_site()) {
      const auto& clipboardCache = mCaches[aWhichClipboard];
      clipboardCache->UpdateLocalOnly(
          LocalCopyState::eBlocked, pendingCopy->mTransferable,
          pendingCopy->mOwner, clipboardCache->GetSequenceNumber(),
          pendingCopy->mWindowContext);
    }
#else
    (void)wrotePlaceholder;
#endif
    pendingCopy->Complete(NS_ERROR_CONTENT_BLOCKED);
    return;
  }

  SetDataImpl(pendingCopy->mTransferable, pendingCopy->mOwner, aWhichClipboard,
              pendingCopy->mWindowContext, /* aCheckContentAnalysis */ false,
              [pendingCopy](nsresult aRv) { pendingCopy->Complete(aRv); });
}

void nsBaseClipboard::OnCopyContentAnalysisWarn(
    ClipboardType aWhichClipboard, PendingCopy* aPendingCopy,
    nsIContentAnalysisResponse* aResponse) {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(aWhichClipboard == kGlobalClipboard);

  nsAutoCString token;
  if (NS_FAILED(aResponse->GetRequestToken(token)) || token.IsEmpty()) {
    return;
  }

  if (mPendingCopy != aPendingCopy) {
    // Another copy has started analysis in the meantime, so ignore this one.
    // (and report it as blocked)
    MOZ_CLIPBOARD_LOG("%s: ignoring stale copy warning, clipboard=%d",
                      __FUNCTION__, aWhichClipboard);
    mozilla::contentanalysis::ContentAnalysis::CancelPendingWarn(token);
    return;
  }

  RefPtr<PendingCopy> pendingCopy = std::move(mPendingCopy);
  MOZ_CLIPBOARD_LOG("%s: copy warned by content analysis, clipboard=%d",
                    __FUNCTION__, aWhichClipboard);

  // The placeholder tells other applications (and other sites) where the
  // content went; the copying page keeps pasting the real data.
  if (!WriteCopyWarnPlaceholder(aWhichClipboard)) {
    // Nothing is holding the data for the user to decide on, so answer the
    // agent now; the resulting block verdict finds no matching copy.
    mozilla::contentanalysis::ContentAnalysis::CancelPendingWarn(token);
    pendingCopy->Complete(NS_ERROR_CONTENT_BLOCKED);
    return;
  }
  const auto& clipboardCache = mCaches[aWhichClipboard];
  clipboardCache->UpdateLocalOnly(
      LocalCopyState::eWarn, pendingCopy->mTransferable, pendingCopy->mOwner,
      clipboardCache->GetSequenceNumber(), pendingCopy->mWindowContext, token);
  // From the page's point of view the copy happened: it is pasteable in the
  // copying page, and the user may yet allow it everywhere. Matches the
  // execCommand path, so a warned cut deletes its selection like an editor
  // cut does.
  pendingCopy->Complete(NS_OK);
}

nsresult nsBaseClipboard::SetDataImpl(
    nsITransferable* aTransferable, nsIClipboardOwner* aOwner,
    ClipboardType aWhichClipboard, mozilla::dom::WindowContext* aWindowContext,
    bool aCheckContentAnalysis, SetDataCompletion&& aCompletion) {
  NS_ASSERTION(aTransferable, "clipboard given a null transferable");

  MOZ_CLIPBOARD_LOG("%s: clipboard=%d", __FUNCTION__, aWhichClipboard);

  // Runs aCompletion on every early return, so callers that need the final
  // result always hear about it exactly once.
  auto finish = [&aCompletion](nsresult aRv) {
    if (aCompletion) {
      SetDataCompletion completion = std::move(aCompletion);
      completion(aRv);
    }
    return aRv;
  };

  if (!nsIClipboard::IsClipboardTypeSupported(aWhichClipboard)) {
    MOZ_CLIPBOARD_LOG("%s: clipboard %d is not supported.", __FUNCTION__,
                      aWhichClipboard);
    return finish(NS_ERROR_FAILURE);
  }

  if (MOZ_CLIPBOARD_LOG_ENABLED()) {
    nsTArray<nsCString> flavors;
    if (NS_SUCCEEDED(aTransferable->FlavorsTransferableCanImport(flavors))) {
      for (const auto& flavor : flavors) {
        MOZ_CLIPBOARD_LOG("    MIME %s", flavor.get());
      }
    }
  }

  // A clipboard write may still be on the stack, having spun a nested event
  // loop or pumped the native message queue while rendering its data.
  // Overwriting the native clipboard now would free state that the other
  // commit is still using.  We fail the new request now rather than clearing
  // the clipboard and queueing the incoming clipboard write.  This only covers
  // the step of a write that can nest an event loop.  A copy still awaiting a
  // content analysis verdict is not on the stack, and is superseded below
  // instead.
  if (mMutatingNativeClipboard) {
    MOZ_CLIPBOARD_LOG("%s: rejecting re-entrant write.", __FUNCTION__);
    return finish(NS_ERROR_IN_PROGRESS);
  }

  const auto& clipboardCache = mCaches[aWhichClipboard];
  MOZ_ASSERT(clipboardCache);
  if (aTransferable == clipboardCache->GetTransferable() &&
      aOwner == clipboardCache->GetClipboardOwner()) {
    MOZ_CLIPBOARD_LOG("%s: skipping update.", __FUNCTION__);
    return finish(NS_OK);
  }

  // Actually changing the clipboard supersedes any copy still awaiting a
  // verdict for it.
  CancelPendingCopy(aWhichClipboard, NS_ERROR_ABORT);

  // Ask Content Analysis whether web content is permitted to copy this data.
  // The check is asynchronous on this (the parent's main) thread, as the agent
  // may be slow, so the clipboard is left as it was until the verdict arrives.
  // Whether the copying page waits for the verdict is nsClipboardProxy's
  // decision: it either blocks in a sync IPC call that
  // ClipboardContentAnalysisParent only answers once aCompletion has run, or
  // (with keep_blocked_data_for_same_site) returns at once and relies on the
  // pending data being cached as local-only below.
  if (aCheckContentAnalysis &&
      NeedsCopyContentAnalysis(aTransferable, aWhichClipboard,
                               aWindowContext)) {
    CancelPendingCopy(aWhichClipboard, NS_ERROR_ABORT);
    auto pendingCopy = mozilla::MakeRefPtr<PendingCopy>(
        aTransferable, aOwner, aWindowContext, std::move(aCompletion));
    // We only analyze copies to the global clipboard
    MOZ_ASSERT(aWhichClipboard == kGlobalClipboard);
    mPendingCopy = pendingCopy;

#ifdef MOZ_ENTERPRISE
    if (mozilla::StaticPrefs::
            browser_contentanalysis_interception_point_clipboard_copy_keep_blocked_data_for_same_site()) {
      // Make the data available to same-page pastes right away, so the page
      // doesn't have to wait for the verdict.
      auto sequenceNumber = GetNativeClipboardSequenceNumber(aWhichClipboard);
      if (sequenceNumber.isOk()) {
        clipboardCache->UpdateLocalOnly(LocalCopyState::ePending, aTransferable,
                                        aOwner, sequenceNumber.unwrap(),
                                        aWindowContext);
        // Same-page pastes now read different data under the same sequence
        // number, so clear any cached verdict.
        mozilla::contentanalysis::ContentAnalysis::
            ClearCachedClipboardResponse();
      }
    }
#endif

    // With the data cached as local-only (only ever done in Enterprise builds)
    // a warning need not hold up the page: the user answers it later from the
    // Data protection panel. Otherwise the warning is left to the modal dialog
    // and only its resolved verdict arrives here.
    const bool keptLocally = clipboardCache->IsLocalOnly();
    auto callback =
        mozilla::MakeRefPtr<mozilla::contentanalysis::ContentAnalysisCallback>(
            [self = RefPtr{this}, aWhichClipboard,
             pendingCopy](nsIContentAnalysisResult* aResult) {
              self->OnCopyContentAnalysisResult(
                  aWhichClipboard, pendingCopy,
                  aResult->GetShouldAllowContent());
            },
            [self = RefPtr{this}, aWhichClipboard, pendingCopy](nsresult) {
              self->OnCopyContentAnalysisResult(aWhichClipboard, pendingCopy,
                                                /* aAllowed */ false);
            },
            [self = RefPtr{this}, aWhichClipboard, pendingCopy,
             keptLocally](nsIContentAnalysisResponse* aResponse) {
              if (keptLocally) {
                self->OnCopyContentAnalysisWarn(aWhichClipboard, pendingCopy,
                                                aResponse);
              }
            });
    mozilla::contentanalysis::ContentAnalysis::
        CheckClipboardCopyContentAnalysis(aWindowContext->Canonical(),
                                          aTransferable, keptLocally, callback);
    return NS_OK;
  }

  clipboardCache->Clear();

  nsresult rv = NS_ERROR_FAILURE;
  if (aTransferable) {
    mIgnoreEmptyNotification = true;
    // Reject existing pending asyncSetData request if any.
    RejectPendingAsyncSetDataRequestIfAny(aWhichClipboard);
    SanitizeForClipboard(aTransferable);
    {
      mozilla::AutoRestore<bool> mutating(mMutatingNativeClipboard);
      mMutatingNativeClipboard = true;
      rv = SetNativeClipboardData(aTransferable, aWhichClipboard);
    }
    mIgnoreEmptyNotification = false;
  }
  if (NS_FAILED(rv)) {
    MOZ_CLIPBOARD_LOG("%s: setting native clipboard data failed.",
                      __FUNCTION__);
    return finish(rv);
  }

  auto result = GetNativeClipboardSequenceNumber(aWhichClipboard);
  if (result.isErr()) {
    MOZ_CLIPBOARD_LOG("%s: getting native clipboard change count failed.",
                      __FUNCTION__);
    return finish(result.unwrapErr());
  }

  clipboardCache->Update(aTransferable, aOwner, result.unwrap(),
                         aWindowContext
                             ? mozilla::Some(aWindowContext->InnerWindowId())
                             : mozilla::Nothing());
  return finish(NS_OK);
}

/**
 * Gets the transferable object from system clipboard.
 */
NS_IMETHODIMP nsBaseClipboard::GetData(
    nsITransferable* aTransferable, ClipboardType aWhichClipboard,
    mozilla::dom::WindowContext* aWindowContext) {
  MOZ_CLIPBOARD_LOG("%s: clipboard=%d", __FUNCTION__, aWhichClipboard);

  return GetDataImpl(aTransferable, 0, aWhichClipboard, aWindowContext,
                     /* aCheckContentAnalysis */ true);
}

nsresult nsBaseClipboard::GetDataWithoutContentAnalysis(
    nsITransferable* aTransferable, ClipboardType aWhichClipboard,
    mozilla::dom::WindowContext* aRequestingWindowContext) {
  MOZ_CLIPBOARD_LOG("%s: clipboard=%d", __FUNCTION__, aWhichClipboard);

  return GetDataImpl(aTransferable, 0, aWhichClipboard,
                     aRequestingWindowContext,
                     /* aCheckContentAnalysis */ false);
}

NS_IMETHODIMP nsBaseClipboard::GetDataIfSmallerThan(
    nsITransferable* aTransferable, uint64_t aThreshold,
    ClipboardType aWhichClipboard, mozilla::dom::WindowContext* aWindowContext,
    JSContext* aJSContext, mozilla::dom::Promise** aPromise) {
  nsIGlobalObject* global = xpc::CurrentNativeGlobal(aJSContext);
  if (!global) {
    return NS_ERROR_UNEXPECTED;
  }

  RefPtr<mozilla::dom::Promise> promise =
      mozilla::dom::Promise::Create(global, mozilla::IgnoreErrors());
  if (!promise) {
    return NS_ERROR_UNEXPECTED;
  }

  auto guard = mozilla::MakeScopeExit([&]() { promise.forget(aPromise); });
  nsresult rv = GetDataIfSmallerThanNative(aTransferable, aThreshold,
                                           aWhichClipboard, aWindowContext);
  if (rv == NS_ERROR_CLIPBOARD_TOO_BIG) {
    promise->MaybeResolve(false);
    return NS_OK;
  }

  if (NS_FAILED(rv)) {
    promise->MaybeReject(rv);
    return NS_OK;
  }

  promise->MaybeResolve(true);
  return NS_OK;
}

NS_IMETHODIMP nsBaseClipboard::GetDataIfSmallerThanNative(
    nsITransferable* aTransferable, uint64_t aThreshold,
    ClipboardType aWhichClipboard,
    mozilla::dom::WindowContext* aWindowContext) {
  MOZ_CLIPBOARD_LOG("%s: clipboard=%d", __FUNCTION__, aWhichClipboard);

  return GetDataImpl(aTransferable, aThreshold, aWhichClipboard, aWindowContext,
                     /* aCheckContentAnalysis */ true);
}

nsresult nsBaseClipboard::GetDataImpl(
    nsITransferable* aTransferable, uint64_t aThreshold,
    ClipboardType aWhichClipboard, mozilla::dom::WindowContext* aWindowContext,
    bool aCheckContentAnalysis) {
  if (!aTransferable) {
    NS_ASSERTION(false, "clipboard given a null transferable");
    return NS_ERROR_FAILURE;
  }

  if (!nsIClipboard::IsClipboardTypeSupported(aWhichClipboard)) {
    MOZ_CLIPBOARD_LOG("%s: clipboard %d is not supported.", __FUNCTION__,
                      aWhichClipboard);
    return NS_ERROR_FAILURE;
  }

  auto checkContentAnalysis = [&]() -> nsresult {
    if (aCheckContentAnalysis &&
        !mozilla::contentanalysis::ContentAnalysis::
            CheckClipboardContentAnalysisSync(
                this, aWindowContext ? aWindowContext->Canonical() : nullptr,
                aTransferable, aWhichClipboard)) {
      aTransferable->ClearAllData();
      return NS_ERROR_CONTENT_BLOCKED;
    }
    return NS_OK;
  };

  // Local-only data is not on the native clipboard, so it has to be served
  // from the cache even when a threshold is given.
  if (const auto* clipboardCache =
          GetClipboardCacheForReading(aWhichClipboard, aWindowContext);
      clipboardCache && (!aThreshold || clipboardCache->IsLocalOnly())) {
    if (NS_SUCCEEDED(clipboardCache->GetData(aTransferable))) {
      if (aThreshold &&
          TransferableExceedsThreshold(aTransferable, aThreshold)) {
        aTransferable->ClearAllData();
        return NS_ERROR_CLIPBOARD_TOO_BIG;
      }
      return checkContentAnalysis();
    }
    // The native clipboard holds something other than what this requester
    // last copied, so don't fill flavors the local-only data lacks from it.
    if (clipboardCache->IsLocalOnly()) {
      return NS_OK;
    }
  }

  nsTArray<nsCString> flavors;
  nsresult rv = aTransferable->FlavorsTransferableCanImport(flavors);
  if (NS_FAILED(rv)) {
    return NS_ERROR_FAILURE;
  }

  for (const auto& flavor : flavors) {
    if (!IsValidFlavor(flavor)) {
      continue;
    }
    auto dataOrError =
        GetNativeClipboardData(flavor, aWhichClipboard, aThreshold);
    if (dataOrError.isErr()) {
      if (dataOrError.unwrapErr() == NS_ERROR_CLIPBOARD_TOO_BIG) {
        rv = NS_ERROR_CLIPBOARD_TOO_BIG;
      }
      continue;
    }

    if (dataOrError.inspect()) {
      aTransferable->SetTransferData(flavor.get(), dataOrError.inspect());
      // XXX Maybe try to fill in more types? Is there a point?
      rv = NS_OK;
      break;
    }
  }

  if (rv == NS_ERROR_CLIPBOARD_TOO_BIG) {
    return NS_ERROR_CLIPBOARD_TOO_BIG;
  }

  return checkContentAnalysis();
}

void nsBaseClipboard::MaybeRetryGetAvailableFlavors(
    const nsTArray<nsCString>& aFlavorList, ClipboardType aWhichClipboard,
    nsIClipboardGetDataSnapshotCallback* aCallback, int32_t aRetryCount,
    mozilla::dom::WindowContext* aRequestingWindowContext) {
  MOZ_CLIPBOARD_LOG("%s: clipboard=%d", __FUNCTION__, aWhichClipboard);
  if (MOZ_CLIPBOARD_LOG_ENABLED()) {
    MOZ_CLIPBOARD_LOG("    Asking for content:");
    for (const auto& flavor : aFlavorList) {
      MOZ_CLIPBOARD_LOG("        MIME %s", flavor.get());
    }
  }

  // Note we have to get the clipboard sequence number first before the actual
  // read. This is to use it to verify the clipboard data is still the one we
  // try to read, instead of the later state.
  auto sequenceNumberOrError =
      GetNativeClipboardSequenceNumber(aWhichClipboard);
  if (sequenceNumberOrError.isErr()) {
    MOZ_CLIPBOARD_LOG("%s: unable to get sequence number for clipboard %d.",
                      __FUNCTION__, aWhichClipboard);
    aCallback->OnError(sequenceNumberOrError.unwrapErr());
    return;
  }

  int32_t sequenceNumber = sequenceNumberOrError.unwrap();
  AsyncHasNativeClipboardDataMatchingFlavors(
      aFlavorList, aWhichClipboard,
      [self = RefPtr{this}, callback = nsCOMPtr{aCallback}, aWhichClipboard,
       aRetryCount, flavorList = aFlavorList.Clone(), sequenceNumber,
       requestingWindowContext =
           RefPtr{aRequestingWindowContext}](auto aFlavorsOrError) {
        if (aFlavorsOrError.isErr()) {
          MOZ_CLIPBOARD_LOG(
              "%s: unable to get available flavors for clipboard %d.",
              __FUNCTION__, aWhichClipboard);
          callback->OnError(aFlavorsOrError.unwrapErr());
          return;
        }

        auto sequenceNumberOrError =
            self->GetNativeClipboardSequenceNumber(aWhichClipboard);
        if (sequenceNumberOrError.isErr()) {
          MOZ_CLIPBOARD_LOG(
              "%s: unable to get sequence number for clipboard %d.",
              __FUNCTION__, aWhichClipboard);
          callback->OnError(sequenceNumberOrError.unwrapErr());
          return;
        }

        if (sequenceNumber == sequenceNumberOrError.unwrap()) {
          auto flavorList = std::move(aFlavorsOrError.unwrap());
          if (MOZ_CLIPBOARD_LOG_ENABLED()) {
            for (const auto& flavor : flavorList) {
              MOZ_CLIPBOARD_LOG("    has %s", flavor.get());
            }
          }

          auto clipboardDataSnapshot =
              mozilla::MakeRefPtr<ClipboardDataSnapshot>(
                  aWhichClipboard, sequenceNumber, std::move(flavorList), false,
                  self, requestingWindowContext);
          callback->OnSuccess(clipboardDataSnapshot);
          return;
        }

        if (aRetryCount > 0) {
          MOZ_CLIPBOARD_LOG(
              "%s: clipboard=%d, ignore the data due to the sequence number "
              "doesn't match, retry (%d) ..",
              __FUNCTION__, aWhichClipboard, aRetryCount);
          self->MaybeRetryGetAvailableFlavors(flavorList, aWhichClipboard,
                                              callback, aRetryCount - 1,
                                              requestingWindowContext);
          return;
        }

        MOZ_DIAGNOSTIC_CRASH("How can this happen?!?");
        callback->OnError(NS_ERROR_FAILURE);
      });
}

NS_IMETHODIMP nsBaseClipboard::GetDataSnapshot(
    const nsTArray<nsCString>& aFlavorList, ClipboardType aWhichClipboard,
    mozilla::dom::WindowContext* aRequestingWindowContext,
    nsIPrincipal* aRequestingPrincipal,
    nsIClipboardGetDataSnapshotCallback* aCallback) {
  MOZ_CLIPBOARD_LOG("%s: clipboard=%d", __FUNCTION__, aWhichClipboard);

  if (!aCallback || !aRequestingPrincipal || aFlavorList.IsEmpty()) {
    return NS_ERROR_INVALID_ARG;
  }

  if (!nsIClipboard::IsClipboardTypeSupported(aWhichClipboard)) {
    MOZ_CLIPBOARD_LOG("%s: clipboard %d is not supported.", __FUNCTION__,
                      aWhichClipboard);
    return NS_ERROR_FAILURE;
  }

  // We want to disable security check for automated tests that have the pref
  // set to true, or extension that have clipboard read permission.
  if (mozilla::StaticPrefs::
          dom_events_testing_asyncClipboard_DoNotUseDirectly() ||
      nsContentUtils::PrincipalHasPermission(*aRequestingPrincipal,
                                             nsGkAtoms::clipboardRead)) {
    GetDataSnapshotInternal(aFlavorList, aWhichClipboard,
                            aRequestingWindowContext, aCallback);
    return NS_OK;
  }

  // If cache data is valid, we are the last ones to put something on the native
  // clipboard (or kept data off it for this requester), then check if the data
  // is from the same-origin page,
  if (auto* clipboardCache = GetClipboardCacheIfValid(aWhichClipboard);
      clipboardCache &&
      clipboardCache->GetTransferableFor(
          aRequestingWindowContext ? aRequestingWindowContext->Canonical()
                                   : nullptr)) {
    if (nsCOMPtr<nsIPrincipal> principal = clipboardCache->GetDataPrincipal()) {
      if (aRequestingPrincipal->Subsumes(principal)) {
        MOZ_CLIPBOARD_LOG("%s: clipboard data is from same-origin page.",
                          __FUNCTION__);
        GetDataSnapshotInternal(aFlavorList, aWhichClipboard,
                                aRequestingWindowContext, aCallback);
        return NS_OK;
      }
    }
  }

  RequestUserConfirmation(aWhichClipboard, aFlavorList,
                          aRequestingWindowContext, aRequestingPrincipal,
                          aCallback);
  return NS_OK;
}

already_AddRefed<nsIClipboardDataSnapshot>
nsBaseClipboard::MaybeCreateGetRequestFromClipboardCache(
    const nsTArray<nsCString>& aFlavorList, ClipboardType aClipboardType,
    mozilla::dom::WindowContext* aRequestingWindowContext) {
  MOZ_DIAGNOSTIC_ASSERT(nsIClipboard::IsClipboardTypeSupported(aClipboardType));

  // If we were the last ones to put something on the native clipboard (or
  // kept data off it for this requester), then just use the cached
  // transferable.
  ClipboardCache* clipboardCache =
      GetClipboardCacheForReading(aClipboardType, aRequestingWindowContext);
  if (!clipboardCache) {
    return nullptr;
  }

  nsITransferable* cachedTransferable = clipboardCache->GetTransferableFor(
      aRequestingWindowContext ? aRequestingWindowContext->Canonical()
                               : nullptr);
  MOZ_ASSERT(cachedTransferable);

  nsTArray<nsCString> transferableFlavors;
  if (NS_FAILED(cachedTransferable->FlavorsTransferableCanExport(
          transferableFlavors))) {
    return nullptr;
  }

  nsTArray<nsCString> results;
  for (const auto& flavor : aFlavorList) {
    bool addCustomFormats = flavor.EqualsLiteral(kWebCustomFormatMapType);

    for (const auto& transferableFlavor : transferableFlavors) {
      // Don't expose invalid flavor.
      // XXX: Currently we use the `nsITransferable` passed for clipboard write
      //      as the clipboard cache directly, so it may contains types we don't
      //      support, e.g. a web custom format with parameters.
      //      Ideally, the invalid formats should not be stored in the clipboard
      //      cache.
      if (!IsValidFlavor(transferableFlavor)) {
        continue;
      }

      // Add web custom formats
      if (addCustomFormats &&
          StringBeginsWith(transferableFlavor,
                           nsLiteralCString(kWebCustomFormatPrefix))) {
        MOZ_CLIPBOARD_LOG("    has custom flavor %s", transferableFlavor.get());
        results.AppendElement(transferableFlavor);
      }

      // XXX We need special check for image as we always put the
      // image as "native" on the clipboard.
      if (transferableFlavor.Equals(flavor) ||
          (transferableFlavor.Equals(kNativeImageMime) &&
           nsContentUtils::IsFlavorImage(flavor))) {
        MOZ_CLIPBOARD_LOG("    has %s", flavor.get());
        results.AppendElement(flavor);
      }
    }
  }

  // XXX Do we need to check system clipboard for the flavors that cannot
  // be found in cache?
  return mozilla::MakeAndAddRef<ClipboardDataSnapshot>(
      aClipboardType, clipboardCache->GetSequenceNumber(), std::move(results),
      true /* aFromCache */, this, aRequestingWindowContext);
}

void nsBaseClipboard::GetDataSnapshotInternal(
    const nsTArray<nsCString>& aFlavorList, ClipboardType aClipboardType,
    mozilla::dom::WindowContext* aRequestingWindowContext,
    nsIClipboardGetDataSnapshotCallback* aCallback) {
  MOZ_ASSERT(nsIClipboard::IsClipboardTypeSupported(aClipboardType));

  if (nsCOMPtr<nsIClipboardDataSnapshot> clipboardDataSnapshot =
          MaybeCreateGetRequestFromClipboardCache(aFlavorList, aClipboardType,
                                                  aRequestingWindowContext)) {
    aCallback->OnSuccess(clipboardDataSnapshot);
    return;
  }

  // At this point we can't satisfy the request from cache data so let's
  // look for things other people put on the system clipboard.
  MaybeRetryGetAvailableFlavors(aFlavorList, aClipboardType, aCallback,
                                kGetAvailableFlavorsRetryCount,
                                aRequestingWindowContext);
}

NS_IMETHODIMP nsBaseClipboard::GetDataSnapshotSync(
    const nsTArray<nsCString>& aFlavorList, ClipboardType aWhichClipboard,
    mozilla::dom::WindowContext* aRequestingWindowContext,
    nsIClipboardDataSnapshot** _retval) {
  MOZ_CLIPBOARD_LOG("%s: clipboard=%d", __FUNCTION__, aWhichClipboard);

  *_retval = nullptr;

  if (aFlavorList.IsEmpty()) {
    return NS_ERROR_INVALID_ARG;
  }

  if (!nsIClipboard::IsClipboardTypeSupported(aWhichClipboard)) {
    MOZ_CLIPBOARD_LOG("%s: clipboard %d is not supported.", __FUNCTION__,
                      aWhichClipboard);
    return NS_ERROR_FAILURE;
  }

  if (nsCOMPtr<nsIClipboardDataSnapshot> clipboardDataSnapshot =
          MaybeCreateGetRequestFromClipboardCache(aFlavorList, aWhichClipboard,
                                                  aRequestingWindowContext)) {
    clipboardDataSnapshot.forget(_retval);
    return NS_OK;
  }

  auto sequenceNumberOrError =
      GetNativeClipboardSequenceNumber(aWhichClipboard);
  if (sequenceNumberOrError.isErr()) {
    MOZ_CLIPBOARD_LOG("%s: unable to get sequence number for clipboard %d.",
                      __FUNCTION__, aWhichClipboard);
    return sequenceNumberOrError.unwrapErr();
  }

  nsTArray<nsCString> results;
  for (const auto& flavor : aFlavorList) {
    if (flavor.EqualsLiteral(kWebCustomFormatMapType)) {
      results.AppendElements(GetWebCustomFormatsFromClipboard(aWhichClipboard));
      continue;
    }
    MOZ_CLIPBOARD_LOG("%s: Asking for MIME %s", __FUNCTION__, flavor.get());
    auto resultOrError = HasNativeClipboardDataMatchingFlavors(
        AutoTArray<nsCString, 1>{flavor}, aWhichClipboard);
    if (resultOrError.isOk() && resultOrError.unwrap()) {
      MOZ_CLIPBOARD_LOG("    has %s", flavor.get());
      results.AppendElement(flavor);
    }
  }

  *_retval =
      mozilla::MakeAndAddRef<ClipboardDataSnapshot>(
          aWhichClipboard, sequenceNumberOrError.unwrap(), std::move(results),
          false /* aFromCache */, this, aRequestingWindowContext)
          .take();
  return NS_OK;
}

NS_IMETHODIMP nsBaseClipboard::EmptyClipboard(ClipboardType aWhichClipboard) {
  MOZ_CLIPBOARD_LOG("%s: clipboard=%d", __FUNCTION__, aWhichClipboard);

  if (!nsIClipboard::IsClipboardTypeSupported(aWhichClipboard)) {
    MOZ_CLIPBOARD_LOG("%s: clipboard %d is not supported.", __FUNCTION__,
                      aWhichClipboard);
    return NS_ERROR_FAILURE;
  }

  if (mMutatingNativeClipboard) {
    // We are in the middle of a clipboard operation.  Don't cancel/empty.
    // See SetDataImpl.
    MOZ_CLIPBOARD_LOG("%s: rejecting re-entrant empty.", __FUNCTION__);
    return NS_ERROR_IN_PROGRESS;
  }

  // Emptying the clipboard supersedes any copy still awaiting a verdict, so
  // that a late "allow" doesn't repopulate what we just cleared.
  CancelPendingCopy(aWhichClipboard, NS_ERROR_ABORT);

  {
    mozilla::AutoRestore<bool> mutating(mMutatingNativeClipboard);
    mMutatingNativeClipboard = true;
    EmptyNativeClipboardData(aWhichClipboard);
  }

  const auto& clipboardCache = mCaches[aWhichClipboard];
  MOZ_ASSERT(clipboardCache);

  if (mIgnoreEmptyNotification) {
    MOZ_DIAGNOSTIC_ASSERT(!clipboardCache->GetTransferable() &&
                              !clipboardCache->GetClipboardOwner() &&
                              clipboardCache->GetSequenceNumber() == -1,
                          "How did we have data in clipboard cache here?");
    return NS_OK;
  }

  clipboardCache->Clear();

  return NS_OK;
}

mozilla::Result<nsTArray<nsCString>, nsresult>
nsBaseClipboard::GetFlavorsFromClipboardCache(ClipboardType aClipboardType) {
  MOZ_ASSERT(mozilla::StaticPrefs::widget_clipboard_use_cached_data_enabled());
  MOZ_ASSERT(nsIClipboard::IsClipboardTypeSupported(aClipboardType));

  // Local-only data is not on the native clipboard, so its flavors aren't
  // what the clipboard has.
  const auto* clipboardCache = GetClipboardCacheIfValid(aClipboardType);
  if (!clipboardCache || clipboardCache->IsLocalOnly()) {
    return mozilla::Err(NS_ERROR_FAILURE);
  }

  nsITransferable* cachedTransferable = clipboardCache->GetTransferable();
  MOZ_ASSERT(cachedTransferable);

  nsTArray<nsCString> flavors;
  nsresult rv = cachedTransferable->FlavorsTransferableCanExport(flavors);
  if (NS_FAILED(rv)) {
    return mozilla::Err(rv);
  }

  if (MOZ_CLIPBOARD_LOG_ENABLED()) {
    MOZ_CLIPBOARD_LOG("    Cached transferable types (nums %zu)\n",
                      flavors.Length());
    for (const auto& flavor : flavors) {
      MOZ_CLIPBOARD_LOG("        MIME %s", flavor.get());
    }
  }

  return std::move(flavors);
}

NS_IMETHODIMP
nsBaseClipboard::HasDataMatchingFlavors(const nsTArray<nsCString>& aFlavorList,
                                        ClipboardType aWhichClipboard,
                                        bool* aOutResult) {
  MOZ_CLIPBOARD_LOG("%s: clipboard=%d", __FUNCTION__, aWhichClipboard);

  if (!nsIClipboard::IsClipboardTypeSupported(aWhichClipboard)) {
    MOZ_CLIPBOARD_LOG("%s: clipboard %d is not supported.", __FUNCTION__,
                      aWhichClipboard);
    return NS_ERROR_FAILURE;
  }

  if (MOZ_CLIPBOARD_LOG_ENABLED()) {
    MOZ_CLIPBOARD_LOG("    Asking for content clipboard=%i:\n",
                      aWhichClipboard);
    for (const auto& flavor : aFlavorList) {
      MOZ_CLIPBOARD_LOG("        MIME %s", flavor.get());
    }
  }

  *aOutResult = false;

  if (mozilla::StaticPrefs::widget_clipboard_use_cached_data_enabled()) {
    // First, check if we have valid data in our cached transferable.
    auto flavorsOrError = GetFlavorsFromClipboardCache(aWhichClipboard);
    if (flavorsOrError.isOk()) {
      for (const auto& transferableFlavor : flavorsOrError.unwrap()) {
        // XXX: Currently we use the `nsITransferable` passed for clipboard
        //      write as the clipboard cache directly, so it may contains types
        //      we don't support, e.g. a web custom format with parameters.
        //      Ideally, the invalid formats should not be stored in the
        //      clipboard cache.
        if (!IsValidFlavor(transferableFlavor)) {
          continue;
        }
        for (const auto& flavor : aFlavorList) {
          if (transferableFlavor.Equals(flavor)) {
            MOZ_CLIPBOARD_LOG("    has %s", flavor.get());
            *aOutResult = true;
            return NS_OK;
          }
        }
      }
    }
  }

  nsTArray<nsCString> validFlavors;
  for (const auto& flavor : aFlavorList) {
    if (IsValidFlavor(flavor)) {
      validFlavors.AppendElement(flavor);
    }
  }

  auto resultOrError =
      HasNativeClipboardDataMatchingFlavors(validFlavors, aWhichClipboard);
  if (resultOrError.isErr()) {
    MOZ_CLIPBOARD_LOG(
        "%s: checking native clipboard data matching flavors falied.",
        __FUNCTION__);
    return resultOrError.unwrapErr();
  }

  *aOutResult = resultOrError.unwrap();
  return NS_OK;
}

NS_IMETHODIMP
nsBaseClipboard::IsClipboardTypeSupported(ClipboardType aWhichClipboard,
                                          bool* aRetval) {
  NS_ENSURE_ARG_POINTER(aRetval);
  switch (aWhichClipboard) {
    case kGlobalClipboard:
      // We always support the global clipboard.
      *aRetval = true;
      return NS_OK;
    case kSelectionClipboard:
      *aRetval = mClipboardCaps.supportsSelectionClipboard();
      return NS_OK;
    case kFindClipboard:
      *aRetval = mClipboardCaps.supportsFindClipboard();
      return NS_OK;
    case kSelectionCache:
      *aRetval = mClipboardCaps.supportsSelectionCache();
      return NS_OK;
    default:
      *aRetval = false;
      return NS_OK;
  }
}

void nsBaseClipboard::AsyncHasNativeClipboardDataMatchingFlavors(
    const nsTArray<nsCString>& aFlavorList, ClipboardType aWhichClipboard,
    HasMatchingFlavorsCallback&& aCallback) {
  MOZ_DIAGNOSTIC_ASSERT(
      nsIClipboard::IsClipboardTypeSupported(aWhichClipboard));

  MOZ_CLIPBOARD_LOG(
      "nsBaseClipboard::AsyncHasNativeClipboardDataMatchingFlavors: "
      "clipboard=%d",
      aWhichClipboard);

  nsTArray<nsCString> results;
  for (const auto& flavor : aFlavorList) {
    if (!IsValidFlavor(flavor)) {
      continue;
    }
    if (flavor.EqualsLiteral(kWebCustomFormatMapType)) {
      // The map type is synthetic: expand it into the per-format flavors and
      // don't also report the map type itself as present, otherwise consumers
      // would see it duplicated in the snapshot's flavor list.
      results.AppendElements(GetWebCustomFormatsFromClipboard(aWhichClipboard));
      continue;
    }
    auto resultOrError = HasNativeClipboardDataMatchingFlavors(
        AutoTArray<nsCString, 1>{flavor}, aWhichClipboard);
    if (resultOrError.isOk() && resultOrError.unwrap()) {
      results.AppendElement(flavor);
    }
  }
  aCallback(std::move(results));
}

nsTArray<nsCString> nsBaseClipboard::GetWebCustomFormatsFromClipboard(
    ClipboardType aWhichClipboard) {
  MOZ_CLIPBOARD_LOG("%s: clipboard=%d", __FUNCTION__, aWhichClipboard);

  nsTArray<nsCString> results;

  // The clipboard.readCustomFormatsFromClipboard.enabled pref hides web
  // custom flavors originating from other applications. We still want a page
  // to read back its own writes regardless of the pref. To distinguish the
  // two cases, consult the clipboard cache: SetData() populates the cache
  // (and snapshots the native clipboard's sequence number) on every write,
  // independent of widget.clipboard.use-cached-data.enabled, so a valid
  // cache entry means this Firefox process owns the current clipboard data.
  // When the cache is valid, allow the read; otherwise honour the pref.
  // This makes the gate work consistently on Windows and Linux, where the
  // read path doesn't otherwise consult the cache. Local-only cached data
  // says nothing about who owns the native clipboard.
  const auto* clipboardCache = GetClipboardCacheIfValid(aWhichClipboard);
  if ((!clipboardCache || clipboardCache->IsLocalOnly()) &&
      !mozilla::StaticPrefs::
          clipboard_readCustomFormatsFromClipboard_enabled()) {
    return results;
  }

  auto customFormatsOrErr = GetNativeClipboardData(
      nsLiteralCString(kWebCustomFormatMapType), aWhichClipboard);

  if (customFormatsOrErr.isErr()) {
    return results;
  }

  nsCOMPtr<nsIArray> customFormats =
      do_QueryInterface(customFormatsOrErr.inspect());
  if (!customFormats) {
    return results;
  }

  nsCOMPtr<nsISimpleEnumerator> enumerator;
  nsresult rv = customFormats->Enumerate(getter_AddRefs(enumerator));
  if (NS_FAILED(rv)) {
    return results;
  }
  bool hasMore = false;
  while (NS_SUCCEEDED(enumerator->HasMoreElements(&hasMore)) && hasMore) {
    nsCOMPtr<nsISupports> element;
    rv = enumerator->GetNext(getter_AddRefs(element));
    if (NS_FAILED(rv)) {
      continue;
    }
    nsCOMPtr<nsISupportsCString> flavor = do_QueryInterface(element);
    if (!flavor) {
      continue;
    }
    nsAutoCString customFormat;
    flavor->GetData(customFormat);
    results.AppendElement(customFormat);
  }

  return results;
}

void nsBaseClipboard::AsyncGetNativeClipboardData(
    const nsACString& aFlavor, ClipboardType aWhichClipboard,
    GetNativeDataCallback&& aCallback) {
  MOZ_ASSERT(IsValidFlavor(aFlavor));
  aCallback(GetNativeClipboardData(aFlavor, aWhichClipboard));
}

void nsBaseClipboard::ClearClipboardCache(ClipboardType aClipboardType) {
  MOZ_ASSERT(nsIClipboard::IsClipboardTypeSupported(aClipboardType));
  const mozilla::UniquePtr<ClipboardCache>& cache = mCaches[aClipboardType];
  MOZ_ASSERT(cache);
  cache->Clear();
}

/*static*/
bool nsBaseClipboard::IsValidFlavor(const nsACString& aFlavor) {
  nsLiteralCString customPrefix(kWebCustomFormatPrefix);
  if (!StringBeginsWith(aFlavor, customPrefix)) {
    // return true for any other mime type, even if with parameters
    return true;
  }
  nsDependentCSubstring mimeType(Substring(aFlavor, customPrefix.Length()));
  RefPtr<CMimeType> parsedType = CMimeType::Parse(mimeType);

  return parsedType && !parsedType->GetParameterCount();
}

void nsBaseClipboard::RequestUserConfirmation(
    ClipboardType aClipboardType, const nsTArray<nsCString>& aFlavorList,
    mozilla::dom::WindowContext* aWindowContext,
    nsIPrincipal* aRequestingPrincipal,
    nsIClipboardGetDataSnapshotCallback* aCallback) {
  MOZ_ASSERT(nsIClipboard::IsClipboardTypeSupported(aClipboardType));
  MOZ_ASSERT(aCallback);

  if (!aWindowContext) {
    aCallback->OnError(NS_ERROR_FAILURE);
    return;
  }

  CanonicalBrowsingContext* cbc =
      CanonicalBrowsingContext::Cast(aWindowContext->GetBrowsingContext());
  MOZ_ASSERT(
      cbc->IsContent(),
      "Should not require user confirmation when access from chrome window");

  RefPtr<CanonicalBrowsingContext> chromeTop = cbc->TopCrossChromeBoundary();
  Document* chromeDoc = chromeTop ? chromeTop->GetDocument() : nullptr;
  if (!chromeDoc || !chromeDoc->HasFocus(mozilla::IgnoreErrors())) {
    MOZ_CLIPBOARD_LOG("%s: reject due to not in the focused window",
                      __FUNCTION__);
    aCallback->OnError(NS_ERROR_FAILURE);
    return;
  }

  mozilla::dom::Element* activeElementInChromeDoc =
      chromeDoc->GetActiveElement();
  if (activeElementInChromeDoc != cbc->Top()->GetEmbedderElement()) {
    // Reject if the request is not from web content that is in the focused tab.
    MOZ_CLIPBOARD_LOG("%s: reject due to not in the focused tab", __FUNCTION__);
    aCallback->OnError(NS_ERROR_FAILURE);
    return;
  }

  // If there is a pending user confirmation request, check if we could reuse
  // it. If not, reject the request.
  if (sUserConfirmationRequest) {
    if (sUserConfirmationRequest->IsEqual(
            aClipboardType, chromeDoc, aRequestingPrincipal, aWindowContext)) {
      sUserConfirmationRequest->AddClipboardGetRequest(aFlavorList, aCallback);
      return;
    }

    aCallback->OnError(NS_ERROR_DOM_NOT_ALLOWED_ERR);
    return;
  }

  nsresult rv = NS_ERROR_FAILURE;
  nsCOMPtr<nsIPromptService> promptService =
      do_GetService("@mozilla.org/prompter;1", &rv);
  if (NS_FAILED(rv)) {
    aCallback->OnError(NS_ERROR_DOM_NOT_ALLOWED_ERR);
    return;
  }

  RefPtr<mozilla::dom::Promise> promise;
  if (NS_FAILED(promptService->ConfirmUserPaste(aWindowContext->Canonical(),
                                                getter_AddRefs(promise)))) {
    aCallback->OnError(NS_ERROR_DOM_NOT_ALLOWED_ERR);
    return;
  }

  sUserConfirmationRequest = new UserConfirmationRequest(
      aClipboardType, chromeDoc, aRequestingPrincipal, this, aWindowContext);
  sUserConfirmationRequest->AddClipboardGetRequest(aFlavorList, aCallback);
  promise->AppendNativeHandler(sUserConfirmationRequest);
}

/* static */
nsresult nsBaseClipboard::SanitizeForClipboard(nsITransferable* aTransferable) {
  NS_ENSURE_ARG(aTransferable);

  nsTArray<nsCString> flavors;
  nsresult rv = aTransferable->FlavorsTransferableCanImport(flavors);
  NS_ENSURE_SUCCESS(rv, rv);

  // Remove NULs from text flavors.
  for (const auto& flavor : flavors) {
    nsCOMPtr<nsISupports> data;
    rv = aTransferable->GetTransferData(flavor.get(), getter_AddRefs(data));
    NS_ENSURE_SUCCESS(rv, rv);
    if (NS_WARN_IF(MOZ_UNLIKELY(!data))) {
      continue;
    }
    nsCOMPtr<nsISupportsString> stringData = do_QueryInterface(data);
    if (!stringData) {
      continue;
    }

    // Remove NULs from stringData.  If that does anything then the size of the
    // string will be reduced.
    nsAutoString newString;
    rv = stringData->GetData(newString);
    NS_ENSURE_SUCCESS(rv, rv);
    auto oldLength = newString.Length();
    newString.StripChar(L'\0');
    if (newString.Length() != oldLength) {
      rv = stringData->SetData(newString);
      NS_ENSURE_SUCCESS(rv, rv);
    }
  }
  return NS_OK;
}

NS_IMPL_ISUPPORTS(nsBaseClipboard::ClipboardDataSnapshot,
                  nsIClipboardDataSnapshot)

nsBaseClipboard::ClipboardDataSnapshot::ClipboardDataSnapshot(
    nsIClipboard::ClipboardType aClipboardType, int32_t aSequenceNumber,
    nsTArray<nsCString>&& aFlavors, bool aFromCache,
    nsBaseClipboard* aClipboard,
    mozilla::dom::WindowContext* aRequestingWindowContext)
    : mClipboardType(aClipboardType),
      mSequenceNumber(aSequenceNumber),
      mFlavors(std::move(aFlavors)),
      mFromCache(aFromCache),
      mClipboard(aClipboard),
      mRequestingWindowContext(aRequestingWindowContext) {
  MOZ_ASSERT(mClipboard);
  MOZ_ASSERT(
      mClipboard->nsIClipboard::IsClipboardTypeSupported(mClipboardType));
}

NS_IMETHODIMP nsBaseClipboard::ClipboardDataSnapshot::GetValid(
    bool* aOutResult) {
  *aOutResult = IsValid();
  return NS_OK;
}

NS_IMETHODIMP nsBaseClipboard::ClipboardDataSnapshot::GetFlavorList(
    nsTArray<nsCString>& aFlavors) {
  aFlavors.AppendElements(mFlavors);
  return NS_OK;
}

NS_IMETHODIMP nsBaseClipboard::ClipboardDataSnapshot::GetData(
    nsITransferable* aTransferable,
    nsIAsyncClipboardRequestCallback* aCallback) {
  MOZ_CLIPBOARD_LOG("ClipboardDataSnapshot::GetData: %p", this);

  if (!aTransferable || !aCallback) {
    return NS_ERROR_INVALID_ARG;
  }

  nsTArray<nsCString> flavors;
  nsresult rv = aTransferable->FlavorsTransferableCanImport(flavors);
  if (NS_FAILED(rv)) {
    return rv;
  }

  if (flavors.IsEmpty()) {
    return NS_OK;
  }

  // If the requested flavor is not in the list, throw an error.
  for (const auto& flavor : flavors) {
    if (!mFlavors.Contains(flavor)) {
      return NS_ERROR_FAILURE;
    }
  }

  if (!IsValid()) {
    aCallback->OnComplete(NS_ERROR_NOT_AVAILABLE);
    return NS_OK;
  }

  MOZ_ASSERT(mClipboard);

  auto contentAnalysisCallback =
      mozilla::MakeRefPtr<mozilla::contentanalysis::ContentAnalysisCallback>(
          [transferable = nsCOMPtr{aTransferable},
           callback = nsCOMPtr{aCallback}](nsIContentAnalysisResult* aResult) {
            if (aResult->GetShouldAllowContent()) {
              callback->OnComplete(NS_OK);
            } else {
              transferable->ClearAllData();
              callback->OnComplete(NS_ERROR_CONTENT_BLOCKED);
            }
          });

  if (mFromCache) {
    const auto* clipboardCache = mClipboard->GetClipboardCacheForReading(
        mClipboardType, mRequestingWindowContext);
    // `IsValid()` above ensures we should get a valid cache and matched
    // sequence number here.
    MOZ_DIAGNOSTIC_ASSERT(clipboardCache);
    MOZ_DIAGNOSTIC_ASSERT(clipboardCache->GetSequenceNumber() ==
                          mSequenceNumber);
    // Local-only data is not on the native clipboard, so never fall back to
    // it.
    if (NS_SUCCEEDED(clipboardCache->GetData(aTransferable)) ||
        clipboardCache->IsLocalOnly()) {
      mozilla::contentanalysis::ContentAnalysis::CheckClipboardContentAnalysis(
          mClipboard,
          mRequestingWindowContext ? mRequestingWindowContext->Canonical()
                                   : nullptr,
          aTransferable, mClipboardType, contentAnalysisCallback);
      return NS_OK;
    }

    // At this point we can't satisfy the request from cache data so let's look
    // for things other people put on the system clipboard.
  }

  // Since this is an async operation, we need to check if the data is still
  // valid after we get the result.
  GetDataInternal(
      std::move(flavors), 0, aTransferable,
      [callback = nsCOMPtr{aCallback}, self = RefPtr{this},
       transferable = nsCOMPtr{aTransferable},
       contentAnalysisCallback =
           std::move(contentAnalysisCallback)](nsresult aResult) mutable {
        if (NS_FAILED(aResult)) {
          callback->OnComplete(aResult);
          return;
        }
        // `IsValid()` checks the clipboard sequence number to ensure the data
        // we are requesting is still valid.
        if (!self->IsValid()) {
          callback->OnComplete(NS_ERROR_NOT_AVAILABLE);
          return;
        }
        mozilla::contentanalysis::ContentAnalysis::
            CheckClipboardContentAnalysis(
                self->mClipboard,
                self->mRequestingWindowContext
                    ? self->mRequestingWindowContext->Canonical()
                    : nullptr,
                transferable, self->mClipboardType, contentAnalysisCallback);
      });
  return NS_OK;
}

NS_IMETHODIMP nsBaseClipboard::ClipboardDataSnapshot::GetDataSync(
    nsITransferable* aTransferable) {
  MOZ_CLIPBOARD_LOG("ClipboardDataSnapshot::GetDataSync: %p", this);

  if (!aTransferable) {
    return NS_ERROR_INVALID_ARG;
  }

  nsTArray<nsCString> flavors;
  nsresult rv = aTransferable->FlavorsTransferableCanImport(flavors);
  if (NS_FAILED(rv)) {
    return rv;
  }

  // If the requested flavor is not in the list, throw an error.
  for (const auto& flavor : flavors) {
    if (!mFlavors.Contains(flavor)) {
      return NS_ERROR_FAILURE;
    }
  }

  if (!IsValid()) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  MOZ_ASSERT(mClipboard);

  if (mFromCache) {
    const auto* clipboardCache = mClipboard->GetClipboardCacheForReading(
        mClipboardType, mRequestingWindowContext);
    // `IsValid()` above ensures we should get a valid cache and matched
    // sequence number here.
    MOZ_DIAGNOSTIC_ASSERT(clipboardCache);
    MOZ_DIAGNOSTIC_ASSERT(clipboardCache->GetSequenceNumber() ==
                          mSequenceNumber);
    // Local-only data is not on the native clipboard, so never fall back to
    // it.
    if (NS_SUCCEEDED(clipboardCache->GetData(aTransferable)) ||
        clipboardCache->IsLocalOnly()) {
      bool shouldAllowContent = mozilla::contentanalysis::ContentAnalysis::
          CheckClipboardContentAnalysisSync(
              mClipboard,
              mRequestingWindowContext ? mRequestingWindowContext->Canonical()
                                       : nullptr,
              aTransferable, mClipboardType);
      if (shouldAllowContent) {
        return NS_OK;
      }
      aTransferable->ClearAllData();
      return NS_ERROR_CONTENT_BLOCKED;
    }

    // At this point we can't satisfy the request from cache data so let's look
    // for things other people put on the system clipboard.
  }

  for (const auto& flavor : flavors) {
    auto dataOrError =
        mClipboard->GetNativeClipboardData(flavor, mClipboardType);
    if (dataOrError.isErr()) {
      continue;
    }

    if (dataOrError.inspect()) {
      aTransferable->SetTransferData(flavor.get(), dataOrError.inspect());
      // XXX Maybe try to fill in more types? Is there a point?
      break;
    }
  }

  bool shouldAllowContent = mozilla::contentanalysis::ContentAnalysis::
      CheckClipboardContentAnalysisSync(
          mClipboard,
          mRequestingWindowContext ? mRequestingWindowContext->Canonical()
                                   : nullptr,
          aTransferable, mClipboardType);
  if (shouldAllowContent) {
    return NS_OK;
  }
  aTransferable->ClearAllData();
  return NS_ERROR_CONTENT_BLOCKED;
}

bool nsBaseClipboard::ClipboardDataSnapshot::IsValid() {
  if (!mClipboard) {
    return false;
  }

  // If the data should from cache, check if cache is still valid or the
  // sequence numbers are matched.
  if (mFromCache) {
    const auto* clipboardCache = mClipboard->GetClipboardCacheForReading(
        mClipboardType, mRequestingWindowContext);
    if (!clipboardCache) {
      mClipboard = nullptr;
      return false;
    }

    return mSequenceNumber == clipboardCache->GetSequenceNumber();
  }

  auto resultOrError =
      mClipboard->GetNativeClipboardSequenceNumber(mClipboardType);
  if (resultOrError.isErr()) {
    mClipboard = nullptr;
    return false;
  }

  if (mSequenceNumber != resultOrError.unwrap()) {
    mClipboard = nullptr;
    return false;
  }

  return true;
}

void nsBaseClipboard::ClipboardDataSnapshot::GetDataInternal(
    nsTArray<nsCString>&& aTypes, nsTArray<nsCString>::index_type aIndex,
    nsITransferable* aTransferable, GetDataInternalCallback&& aCallback) {
  MOZ_ASSERT(aIndex < aTypes.Length());

  // Since this is an async operation, we need to check if the data is still
  // valid after we get the result.
  nsCString type = aTypes[aIndex];
  mClipboard->AsyncGetNativeClipboardData(
      type, mClipboardType,
      [self = RefPtr{this}, types = std::move(aTypes), index = aIndex,
       transferable = nsCOMPtr{aTransferable}, callback = std::move(aCallback)](
          mozilla::Result<nsCOMPtr<nsISupports>, nsresult> aResult) mutable {
        MOZ_ASSERT(index < types.Length());

        // `IsValid()` checks the clipboard sequence number to ensure the data
        // we are requesting is still valid.
        if (!self->IsValid()) {
          callback(NS_ERROR_NOT_AVAILABLE);
          return;
        }

        if (!aResult.isErr() && aResult.inspect()) {
          transferable->SetTransferData(types[index].get(), aResult.inspect());
          callback(NS_OK);
          return;
        }

        // No more types to try.
        if (++index >= types.Length()) {
          callback(NS_OK);
          return;
        }

        // Recursively call GetDataInternal to try the next type.
        self->GetDataInternal(std::move(types), index, transferable,
                              std::move(callback));
      });
}

NS_IMPL_ISUPPORTS(nsBaseClipboard::ClipboardPopulatedDataSnapshot,
                  nsIClipboardDataSnapshot)

nsBaseClipboard::ClipboardPopulatedDataSnapshot::ClipboardPopulatedDataSnapshot(
    nsITransferable* aTransferable)
    : mTransferable(aTransferable) {
  MOZ_ASSERT(mTransferable);
  aTransferable->FlavorsTransferableCanExport(mFlavors);
}

NS_IMETHODIMP nsBaseClipboard::ClipboardPopulatedDataSnapshot::GetValid(
    bool* aOutResult) {
  // Since this is a snapshot of what the clipboard data was, this is always
  // valid
  *aOutResult = true;
  return NS_OK;
}

NS_IMETHODIMP nsBaseClipboard::ClipboardPopulatedDataSnapshot::GetFlavorList(
    nsTArray<nsCString>& aFlavors) {
  aFlavors.AppendElements(mFlavors);
  return NS_OK;
}

NS_IMETHODIMP nsBaseClipboard::ClipboardPopulatedDataSnapshot::GetData(
    nsITransferable* aTransferable,
    nsIAsyncClipboardRequestCallback* aCallback) {
  if (!aTransferable || !aCallback) {
    return NS_ERROR_INVALID_ARG;
  }

  NS_DispatchToMainThread(NS_NewRunnableFunction(
      "ClipboardPopulatedDataSnapshot::GetData",
      [self = RefPtr{this}, transferable = RefPtr{aTransferable},
       callback = RefPtr{aCallback}]() {
        nsresult rv = self->GetDataSync(transferable);
        callback->OnComplete(rv);
      }));

  return NS_OK;
}

NS_IMETHODIMP nsBaseClipboard::ClipboardPopulatedDataSnapshot::GetDataSync(
    nsITransferable* aTransferable) {
  MOZ_CLIPBOARD_LOG("ClipboardPopulatedDataSnapshot::GetDataSync: %p", this);

  if (!aTransferable) {
    return NS_ERROR_INVALID_ARG;
  }

  nsTArray<nsCString> flavors;
  nsresult rv = aTransferable->FlavorsTransferableCanImport(flavors);
  if (NS_FAILED(rv)) {
    return rv;
  }

  // If the requested flavor is not in the list, throw an error.
  for (const auto& flavor : flavors) {
    if (!mFlavors.Contains(flavor)) {
      return NS_ERROR_FAILURE;
    }
  }

  // This method only fills in the data for the first flavor passed in. This
  // seems weird but matches the IDL documentation and behavior.
  if (!flavors.IsEmpty()) {
    nsCOMPtr<nsISupports> data;
    rv = mTransferable->GetTransferData(flavors[0].get(), getter_AddRefs(data));
    if (NS_FAILED(rv)) {
      aTransferable->ClearAllData();
      return rv;
    }
    rv = aTransferable->SetTransferData(flavors[0].get(), data);
    if (NS_FAILED(rv)) {
      aTransferable->ClearAllData();
      return rv;
    }
  }
  return NS_OK;
}

mozilla::Maybe<uint64_t> nsBaseClipboard::GetClipboardCacheInnerWindowId(
    ClipboardType aClipboardType) {
  auto* clipboardCache = GetClipboardCacheIfValid(aClipboardType);
  return clipboardCache ? clipboardCache->GetInnerWindowId()
                        : mozilla::Nothing();
}

nsBaseClipboard::ClipboardCache* nsBaseClipboard::GetClipboardCacheIfValid(
    ClipboardType aClipboardType) {
  MOZ_ASSERT(nsIClipboard::IsClipboardTypeSupported(aClipboardType));

  const mozilla::UniquePtr<ClipboardCache>& cache = mCaches[aClipboardType];
  MOZ_ASSERT(cache);

  if (!cache->HasData()) {
    MOZ_ASSERT(cache->GetSequenceNumber() == -1);
    return nullptr;
  }

  auto changeCountOrError = GetNativeClipboardSequenceNumber(aClipboardType);
  if (changeCountOrError.isErr()) {
    return nullptr;
  }

  if (changeCountOrError.unwrap() != cache->GetSequenceNumber()) {
    // Clipboard cache is invalid, clear it.
    cache->Clear();
    return nullptr;
  }

  return cache.get();
}

nsBaseClipboard::ClipboardCache* nsBaseClipboard::GetClipboardCacheForReading(
    ClipboardType aClipboardType,
    mozilla::dom::WindowContext* aRequestingWindowContext) {
  ClipboardCache* cache = GetClipboardCacheIfValid(aClipboardType);
  if (!cache) {
    return nullptr;
  }
  if (cache->IsLocalOnly()) {
    return cache->GetTransferableFor(aRequestingWindowContext
                                         ? aRequestingWindowContext->Canonical()
                                         : nullptr)
               ? cache
               : nullptr;
  }
  return mozilla::StaticPrefs::widget_clipboard_use_cached_data_enabled()
             ? cache
             : nullptr;
}

/* static */
bool nsBaseClipboard::TransferableExceedsThreshold(
    nsITransferable* aTransferable, uint64_t aThreshold) {
  nsTArray<nsCString> flavors;
  if (NS_FAILED(aTransferable->FlavorsTransferableCanExport(flavors))) {
    return false;
  }
  for (const auto& flavor : flavors) {
    nsCOMPtr<nsISupports> data;
    if (NS_FAILED(aTransferable->GetTransferData(flavor.get(),
                                                 getter_AddRefs(data)))) {
      continue;
    }
    if (nsCOMPtr<nsISupportsString> stringData = do_QueryInterface(data)) {
      nsAutoString str;
      if (NS_SUCCEEDED(stringData->GetData(str)) &&
          uint64_t(str.Length()) * sizeof(char16_t) > aThreshold) {
        return true;
      }
    }
  }
  return false;
}

nsBaseClipboard::ClipboardCache::~ClipboardCache() {
  // In order to notify the old clipboard owner.
  Clear();
}

void nsBaseClipboard::ClipboardCache::Clear() {
  if (Reset()) {
    NotifyLocalCopyChanged();
  }
}

bool nsBaseClipboard::ClipboardCache::Reset() {
  StopObservingPrivateBrowsingExit();
  const bool wasLocalOnly = IsLocalOnly();
  nsCString undecidedWarn;
  if (wasLocalOnly && mLocalOnly->mState == LocalCopyState::eWarn) {
    undecidedWarn = mLocalOnly->mWarnRequestToken;
  }
  // Local-only data never owned the native clipboard.
  if (mClipboardOwner && !wasLocalOnly) {
    mClipboardOwner->LosingOwnership(mTransferable);
  }
  mClipboardOwner = nullptr;
  mTransferable = nullptr;
  mSequenceNumber = -1;
  mLocalOnly.reset();
  if (!undecidedWarn.IsEmpty()) {
    // The user never got to answer, so the agent hears "denied". This runs
    // the copy's verdict callback re-entrantly, which finds no warned
    // local-only data and does nothing.
    MOZ_CLIPBOARD_LOG("%s: cancelling undecided warn %s", __FUNCTION__,
                      undecidedWarn.get());
    mozilla::contentanalysis::ContentAnalysis::CancelPendingWarn(undecidedWarn);
  }
  return wasLocalOnly;
}

/* static */
void nsBaseClipboard::ClipboardCache::NotifyLocalCopyChanged() {
  MOZ_ASSERT(NS_IsMainThread());
  if (nsCOMPtr<nsIObserverService> obs =
          mozilla::services::GetObserverService()) {
    obs->NotifyObservers(nullptr, "clipboard-local-copy-changed", nullptr);
  }
}

void nsBaseClipboard::ClipboardCache::UpdateLocalOnly(
    LocalCopyState aState, nsITransferable* aTransferable,
    nsIClipboardOwner* aClipboardOwner, int32_t aSequenceNumber,
    mozilla::dom::WindowContext* aSourceWindow,
    const nsACString& aWarnRequestToken) {
  MOZ_ASSERT(aTransferable);
  MOZ_ASSERT(aSourceWindow);
  MOZ_ASSERT_IF(aState == LocalCopyState::eWarn, !aWarnRequestToken.IsEmpty());
  const bool wasLocalOnly = Reset();
  auto notify = mozilla::MakeScopeExit([&]() {
    if (wasLocalOnly || IsLocalOnly()) {
      NotifyLocalCopyChanged();
    }
  });

  nsCOMPtr<nsIPrincipal> principal = aTransferable->GetDataPrincipal();
  if (!principal) {
    principal = aSourceWindow->Canonical()->DocumentPrincipal();
  }
  mozilla::dom::WindowContext* top = aSourceWindow->TopWindowContext();
  if (!principal || !top) {
    return;
  }

  MOZ_CLIPBOARD_LOG(
      "%s: caching local-only data in state %d for sequence number %d",
      __FUNCTION__, static_cast<int>(aState), aSequenceNumber);
  mTransferable = aTransferable;
  mClipboardOwner = aClipboardOwner;
  mSequenceNumber = aSequenceNumber;
  mInnerWindowId = mozilla::Some(aSourceWindow->InnerWindowId());
  mLocalOnly.emplace(
      LocalOnly{aState, aSourceWindow, top->InnerWindowId(), principal,
                aState == LocalCopyState::eWarn ? nsCString(aWarnRequestToken)
                                                : nsCString()});

  if (principal->GetIsInPrivateBrowsing()) {
    StartObservingPrivateBrowsingExit();
  }
}

nsITransferable* nsBaseClipboard::ClipboardCache::GetTransferableFor(
    mozilla::dom::WindowGlobalParent* aRequestingWindow) const {
  if (!IsLocalOnly()) {
    return mTransferable;
  }
  if (!mozilla::contentanalysis::ContentAnalysis::IsSamePageAndSite(
          aRequestingWindow, mLocalOnly->mSourceTopInnerWindowId,
          mLocalOnly->mSourcePrincipal)) {
    MOZ_CLIPBOARD_LOG(
        "%s: requesting window may not read local-only cached data.",
        __FUNCTION__);
    return nullptr;
  }
  return mTransferable;
}

mozilla::Maybe<nsBaseClipboard::LocalCopyInfo>
nsBaseClipboard::ClipboardCache::GetLocalCopyInfo() const {
  if (!IsLocalOnly()) {
    return mozilla::Nothing();
  }
  return mozilla::Some(LocalCopyInfo{
      mLocalOnly->mState, mSequenceNumber, mTransferable,
      mLocalOnly->mSourcePrincipal, mLocalOnly->mWarnRequestToken});
}

nsIPrincipal* nsBaseClipboard::ClipboardCache::GetDataPrincipal() const {
  if (IsLocalOnly()) {
    return mLocalOnly->mSourcePrincipal;
  }
  return mTransferable ? mTransferable->GetDataPrincipal() : nullptr;
}

void nsBaseClipboard::ClipboardCache::StartObservingPrivateBrowsingExit() {
  mObservingPrivateBrowsingExit = true;
  PrivateBrowsingExitObserver::Get()->Start([this]() {
    MOZ_CLIPBOARD_LOG("%s: dropping private-browsing local-only data",
                      __FUNCTION__);
    Clear();
  });
}

void nsBaseClipboard::ClipboardCache::StopObservingPrivateBrowsingExit() {
  if (!mObservingPrivateBrowsingExit) {
    return;
  }
  mObservingPrivateBrowsingExit = false;
  if (auto* observer = PrivateBrowsingExitObserver::GetIfExists()) {
    observer->Stop();
  }
}

nsresult nsBaseClipboard::ClipboardCache::GetData(
    nsITransferable* aTransferable) const {
  MOZ_ASSERT(aTransferable);

  // get flavor list that includes all acceptable flavors (including ones
  // obtained through conversion)
  nsTArray<nsCString> flavors;
  if (NS_FAILED(aTransferable->FlavorsTransferableCanImport(flavors))) {
    return NS_ERROR_FAILURE;
  }

  MOZ_ASSERT(mTransferable);
  for (const auto& flavor : flavors) {
    nsCOMPtr<nsISupports> dataSupports;
    // Get web custom format map data from ClipboardCache::mTransferable.
    // Actually, ClipboardCache::mTransferable does not have web custom format
    // map flavor, kWebCustomFormatMapType, it is only saved in the clipboard.
    // So, get all custom formats from ClipboardCache::mTransferable for web
    // custom format map querying.
    if (flavor.EqualsLiteral(kWebCustomFormatMapType)) {
      nsTArray<nsCString> transferableFlavors;
      if (NS_FAILED(mTransferable->FlavorsTransferableCanExport(
              transferableFlavors))) {
        return NS_ERROR_FAILURE;
      }
      nsCOMPtr<nsIMutableArray> customFormats =
          do_CreateInstance(NS_ARRAY_CONTRACTID);
      for (const auto& transferableFlavor : transferableFlavors) {
        if (StringBeginsWith(transferableFlavor,
                             nsLiteralCString(kWebCustomFormatPrefix))) {
          // XXX: Currently we use the `nsITransferable` passed for clipboard
          //      write as the clipboard cache directly, so it may contains
          //      types we don't support, e.g. a web custom format with
          //      parameters.
          //      Ideally, the invalid formats should not be stored in the
          //      clipboard cache.
          if (!IsValidFlavor(transferableFlavor)) {
            continue;
          }
          nsCOMPtr<nsISupportsCString> customFormat =
              do_CreateInstance(NS_SUPPORTS_CSTRING_CONTRACTID);
          customFormat->SetData(transferableFlavor);
          customFormats->AppendElement(customFormat);
        }
      }
      aTransferable->SetTransferData(flavor.get(), customFormats);
      return NS_OK;
    }

    // XXX: Currently we use the `nsITransferable` passed for clipboard write
    //      as the clipboard cache directly, so it may contains types we don't
    //      support, e.g. a web custom format with parameters.
    //      Ideally, the invalid formats should not be stored in the clipboard
    //      cache.
    if (!IsValidFlavor(flavor)) {
      continue;
    }

    // XXX Maybe we need special check for image as we always put the image as
    // "native" on the clipboard.
    if (NS_SUCCEEDED(mTransferable->GetTransferData(
            flavor.get(), getter_AddRefs(dataSupports)))) {
      MOZ_CLIPBOARD_LOG("%s: getting %s from cache.", __FUNCTION__,
                        flavor.get());
      aTransferable->SetTransferData(flavor.get(), dataSupports);
      // XXX we only read the first available type from native clipboard, so
      // make cache behave the same.
      return NS_OK;
    }
  }

  return NS_ERROR_FAILURE;
}
