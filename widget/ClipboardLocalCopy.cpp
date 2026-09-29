/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/widget/ClipboardLocalCopy.h"

#include "ContentAnalysis.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/Services.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/TextUtils.h"
#include "mozilla/Utf16.h"
#include "mozilla/dom/BrowsingContext.h"
#include "mozilla/dom/WindowContext.h"
#include "mozilla/dom/WindowGlobalParent.h"
#include "nsBaseClipboard.h"
#include "nsIClipboardOwner.h"
#include "nsIObserver.h"
#include "nsIObserverService.h"
#include "nsIPrincipal.h"
#include "nsISupportsPrimitives.h"
#include "nsITransferable.h"

namespace mozilla::widget {

namespace {

constexpr char kLastPrivateBrowsingContextExited[] = "last-pb-context-exited";
constexpr char kLocalCopyChangedTopic[] = "clipboard-local-copy-changed";

// Forwards the last-pb-context-exited notification to the
// ClipboardLocalCopy holding private data.
class PrivateBrowsingExitObserver final : public nsIObserver {
 public:
  NS_DECL_ISUPPORTS

  static PrivateBrowsingExitObserver* Get() {
    if (!sInstance) {
      sInstance = new PrivateBrowsingExitObserver();
      ClearOnShutdown(&sInstance);
    }
    return sInstance;
  }

  void SetOwner(ClipboardLocalCopy* aOwner) { mOwner = aOwner; }

  NS_IMETHOD Observe(nsISupports*, const char* aTopic,
                     const char16_t*) override {
    if (mOwner && !strcmp(aTopic, kLastPrivateBrowsingContextExited)) {
      MOZ_CLIPBOARD_LOG("%s: dropping private-browsing blocked copy",
                        __FUNCTION__);
      mOwner->Clear();
    }
    return NS_OK;
  }

 private:
  ~PrivateBrowsingExitObserver() = default;

  ClipboardLocalCopy* mOwner = nullptr;
  static StaticRefPtr<PrivateBrowsingExitObserver> sInstance;
};

StaticRefPtr<PrivateBrowsingExitObserver>
    PrivateBrowsingExitObserver::sInstance;

NS_IMPL_ISUPPORTS(PrivateBrowsingExitObserver, nsIObserver)

}  // namespace

ClipboardLocalCopy::~ClipboardLocalCopy() { Reset(); }

void ClipboardLocalCopy::Remember(State aState, nsITransferable* aTransferable,
                                  nsIClipboardOwner* aOwner,
                                  int32_t aSequenceNumber,
                                  dom::WindowContext* aSourceWindow) {
  MOZ_ASSERT(aTransferable);
  MOZ_ASSERT(aSourceWindow);
  bool hadData = Reset();
  bool setData = false;
  auto exit = MakeScopeExit([&]() {
    if (hadData || setData) {
      NotifyChanged();
    }
  });

  nsCOMPtr<nsIPrincipal> principal = aTransferable->GetDataPrincipal();
  if (!principal) {
    principal = aSourceWindow->Canonical()->DocumentPrincipal();
  }
  dom::BrowsingContext* browsingContext = aSourceWindow->GetBrowsingContext();
  if (!principal || !browsingContext) {
    return;
  }

  MOZ_CLIPBOARD_LOG("%s: keeping copy in state %d for sequence number %d",
                    __FUNCTION__, static_cast<int>(aState), aSequenceNumber);
  mData.emplace(Data{aState, aTransferable, aOwner, aSourceWindow,
                     aSequenceNumber, aSourceWindow->InnerWindowId(),
                     aSourceWindow->TopWindowContext()->InnerWindowId(),
                     principal});
  setData = true;

  if (principal->GetIsInPrivateBrowsing()) {
    StartObservingPrivateBrowsingExit();
  }
}

void ClipboardLocalCopy::Clear() {
  if (Reset()) {
    NotifyChanged();
  }
}

bool ClipboardLocalCopy::Reset() {
  StopObservingPrivateBrowsingExit();
  if (mData.isNothing()) {
    return false;
  }
  MOZ_CLIPBOARD_LOG("%s", __FUNCTION__);
  mData.reset();
  return true;
}

void ClipboardLocalCopy::NotifyChanged() {
  AssertIsOnMainThread();
  if (nsCOMPtr<nsIObserverService> obs = services::GetObserverService()) {
    obs->NotifyObservers(nullptr, kLocalCopyChangedTopic, nullptr);
  }
}

bool ClipboardLocalCopy::IsCurrent(int32_t aCurrentSequenceNumber) {
  if (mData.isNothing()) {
    return false;
  }
  if (mData->mSequenceNumber != aCurrentSequenceNumber) {
    // Something else has been put on the clipboard since the copy, so this
    // is no longer what the user last copied.
    MOZ_CLIPBOARD_LOG("%s: clipboard changed since the copy.", __FUNCTION__);
    Clear();
    return false;
  }
  return true;
}

ClipboardLocalCopy::State ClipboardLocalCopy::GetState() const {
  MOZ_ASSERT(mData.isSome());
  return mData->mState;
}

nsITransferable* ClipboardLocalCopy::Transferable() const {
  MOZ_ASSERT(mData.isSome());
  return mData->mTransferable;
}

nsIClipboardOwner* ClipboardLocalCopy::Owner() const {
  MOZ_ASSERT(mData.isSome());
  return mData->mOwner;
}

dom::WindowContext* ClipboardLocalCopy::SourceWindow() const {
  MOZ_ASSERT(mData.isSome());
  return mData->mSourceWindow;
}

int32_t ClipboardLocalCopy::SequenceNumber() const {
  MOZ_ASSERT(mData.isSome());
  return mData->mSequenceNumber;
}

uint64_t ClipboardLocalCopy::SourceInnerWindowId() const {
  MOZ_ASSERT(mData.isSome());
  return mData->mSourceInnerWindowId;
}

nsIPrincipal* ClipboardLocalCopy::SourcePrincipal() const {
  MOZ_ASSERT(mData.isSome());
  return mData->mSourcePrincipal;
}

void ClipboardLocalCopy::GetPreviewText(uint32_t aMaxCodePoints,
                                        nsAString& aPreview) const {
  aPreview.Truncate();
  if (mData.isNothing()) {
    return;
  }
  nsCOMPtr<nsISupports> data;
  if (NS_FAILED(mData->mTransferable->GetTransferData(kTextMime,
                                                      getter_AddRefs(data)))) {
    return;
  }
  nsCOMPtr<nsISupportsString> text = do_QueryInterface(data);
  if (!text) {
    return;
  }
  nsAutoString full;
  if (NS_FAILED(text->GetData(full))) {
    return;
  }

  uint32_t codePoints = 0;
  bool pendingSpace = false;
  for (size_t i = 0; i < full.Length(); ++i) {
    char16_t c = full[i];
    if (IsAsciiWhitespace(c)) {
      pendingSpace = !aPreview.IsEmpty();
      continue;
    }
    if (pendingSpace) {
      if (codePoints >= aMaxCodePoints) {
        aPreview.Append(char16_t(0x2026));
        return;
      }
      // coalesce multiple spaces into one space
      aPreview.Append(' ');
      ++codePoints;
      pendingSpace = false;
    }
    if (codePoints >= aMaxCodePoints) {
      aPreview.Append(char16_t(0x2026));
      return;
    }
    if (IsHighSurrogate(c) && i + 1 < full.Length() &&
        IsLowSurrogate(full[i + 1])) {
      aPreview.Append(c);
      aPreview.Append(full[++i]);
    } else {
      aPreview.Append(c);
    }
    ++codePoints;
  }
}

already_AddRefed<nsITransferable> ClipboardLocalCopy::GetDataFor(
    dom::WindowGlobalParent* aRequestingWindow) const {
  if (mData.isNothing()) {
    return nullptr;
  }

  // Only web content in the copying page, and on the same site as the
  // copying window, may see the data.
  if (!contentanalysis::ContentAnalysis::IsSamePageAndSite(
          aRequestingWindow, mData->mSourceTopInnerWindowId,
          mData->mSourcePrincipal)) {
    MOZ_CLIPBOARD_LOG("%s: requesting window is not the copying page and site.",
                      __FUNCTION__);
    return nullptr;
  }

  MOZ_CLIPBOARD_LOG("%s: serving local copy data to the copying page.",
                    __FUNCTION__);
  return do_AddRef(mData->mTransferable);
}

void ClipboardLocalCopy::StartObservingPrivateBrowsingExit() {
  AssertIsOnMainThread();
  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  if (!obs) {
    return;
  }
  auto* observer = PrivateBrowsingExitObserver::Get();
  observer->SetOwner(this);
  obs->AddObserver(observer, kLastPrivateBrowsingContextExited, false);
  mObservingPrivateBrowsingExit = true;
}

void ClipboardLocalCopy::StopObservingPrivateBrowsingExit() {
  AssertIsOnMainThread();
  if (!mObservingPrivateBrowsingExit) {
    return;
  }
  mObservingPrivateBrowsingExit = false;
  auto* observer = PrivateBrowsingExitObserver::Get();
  observer->SetOwner(nullptr);
  if (nsCOMPtr<nsIObserverService> obs = services::GetObserverService()) {
    obs->RemoveObserver(observer, kLastPrivateBrowsingContextExited);
  }
}

}  // namespace mozilla::widget
