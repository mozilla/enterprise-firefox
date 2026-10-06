/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef nsBaseClipboard_h_
#define nsBaseClipboard_h_

#include "mozilla/Array.h"
#include "mozilla/Logging.h"
#include "mozilla/MoveOnlyFunction.h"
#include "mozilla/Result.h"
#include "mozilla/dom/PContent.h"
#include "nsCOMPtr.h"
#include "nsIClipboard.h"
#include "nsITransferable.h"

extern mozilla::LazyLogModule gWidgetClipboardLog;
#define MOZ_CLIPBOARD_LOG(...) \
  MOZ_LOG(gWidgetClipboardLog, mozilla::LogLevel::Debug, (__VA_ARGS__))
#define MOZ_CLIPBOARD_LOG_ENABLED() \
  MOZ_LOG_TEST(gWidgetClipboardLog, mozilla::LogLevel::Debug)

class nsIContentAnalysisResponse;
class nsITransferable;
class nsIClipboardOwner;
class nsIPrincipal;
class nsIWidget;

namespace mozilla::dom {
class WindowContext;
class WindowGlobalParent;
}  // namespace mozilla::dom

/**
 * A base clipboard class for all platform, so that they can share the same
 * implementation.
 */
class nsBaseClipboard : public nsIClipboard {
 public:
  explicit nsBaseClipboard(
      const mozilla::dom::ClipboardCapabilities& aClipboardCaps);

  // nsISupports
  NS_DECL_ISUPPORTS

  // nsIClipboard
  NS_IMETHOD SetData(
      nsITransferable* aTransferable, nsIClipboardOwner* aOwner,
      ClipboardType aWhichClipboard,
      mozilla::dom::WindowContext* aWindowContext) override final;
  NS_IMETHOD AsyncSetData(ClipboardType aWhichClipboard,
                          mozilla::dom::WindowContext* aSettingWindowContext,
                          nsIAsyncClipboardRequestCallback* aCallback,
                          nsIAsyncSetClipboardData** _retval) override final;
  NS_IMETHOD GetData(
      nsITransferable* aTransferable, ClipboardType aWhichClipboard,
      mozilla::dom::WindowContext* aWindowContext) override final;
  NS_IMETHOD GetDataIfSmallerThan(
      nsITransferable* aTransferable, uint64_t aThreshold,
      ClipboardType aWhichClipboard,
      mozilla::dom::WindowContext* aWindowContext, JSContext* aJSContext,
      mozilla::dom::Promise** aPromise) override final;
  // If the clipboard data could not be taken by threshold,
  // returns NS_ERROR_CLIPBOARD_TOO_BIG.
  NS_IMETHOD GetDataIfSmallerThanNative(
      nsITransferable* aTransferable, uint64_t aThreshold,
      ClipboardType aWhichClipboard,
      mozilla::dom::WindowContext* aWindowContext) override final;
  NS_IMETHOD GetDataSnapshot(
      const nsTArray<nsCString>& aFlavorList, ClipboardType aWhichClipboard,
      mozilla::dom::WindowContext* aRequestingWindowContext,
      nsIPrincipal* aRequestingPrincipal,
      nsIClipboardGetDataSnapshotCallback* aCallback) override final;
  NS_IMETHOD GetDataSnapshotSync(
      const nsTArray<nsCString>& aFlavorList, ClipboardType aWhichClipboard,
      mozilla::dom::WindowContext* aRequestingWindowContext,
      nsIClipboardDataSnapshot** _retval) override final;
  NS_IMETHOD EmptyClipboard(ClipboardType aWhichClipboard) override final;
  NS_IMETHOD HasDataMatchingFlavors(const nsTArray<nsCString>& aFlavorList,
                                    ClipboardType aWhichClipboard,
                                    bool* aOutResult) override final;
  NS_IMETHOD IsClipboardTypeSupported(ClipboardType aWhichClipboard,
                                      bool* aRetval) override final;

  void GetDataSnapshotInternal(
      const nsTArray<nsCString>& aFlavorList,
      nsIClipboard::ClipboardType aClipboardType,
      mozilla::dom::WindowContext* aRequestingWindowContext,
      nsIClipboardGetDataSnapshotCallback* aCallback);

  using SetDataCompletion = mozilla::MoveOnlyFunction<void(nsresult)>;

  // Same as SetData, but reports the final result through aCompletion so
  // callers can wait for a content analysis verdict without the main thread
  // spinning its event loop. Used by ClipboardContentAnalysisParent for
  // copies from content processes.
  void SetDataWithCompletion(nsITransferable* aTransferable,
                             nsIClipboardOwner* aOwner,
                             ClipboardType aWhichClipboard,
                             mozilla::dom::WindowContext* aWindowContext,
                             SetDataCompletion&& aCompletion);

  // Same as GetData, but leaves the paste content analysis check to the
  // caller. aRequestingWindowContext is only used to decide whether the
  // requester may read data in the clipboard cache that is not on the native
  // clipboard (see ClipboardCache::UpdateLocalOnly).
  nsresult GetDataWithoutContentAnalysis(
      nsITransferable* aTransferable, ClipboardType aWhichClipboard,
      mozilla::dom::WindowContext* aRequestingWindowContext);

  using GetNativeDataCallback = mozilla::MoveOnlyFunction<void(
      mozilla::Result<nsCOMPtr<nsISupports>, nsresult>)>;
  using HasMatchingFlavorsCallback = mozilla::MoveOnlyFunction<void(
      mozilla::Result<nsTArray<nsCString>, nsresult>)>;
  using GetWebCustomFormatsCallback = mozilla::MoveOnlyFunction<void(
      mozilla::Result<nsTArray<nsCString>, nsresult>)>;

  // What local-only data in the global clipboard cache is waiting for.
  enum class LocalCopyState : uint8_t {
    // A content analysis verdict on the copy.
    ePending,
    // The user's answer to a content analysis warning about the copy.
    eWarn,
    // Nothing: content analysis blocked the copy.
    eBlocked,
  };
  struct LocalCopyInfo {
    LocalCopyState mState;
    int32_t mSequenceNumber;
    nsCOMPtr<nsITransferable> mTransferable;
    nsCOMPtr<nsIPrincipal> mSourcePrincipal;
    // Identifies the undecided warning; empty unless mState is eWarn.
    nsCString mWarnRequestToken;
  };
  // Describes the local-only data in the global clipboard cache, if any is
  // current. In Enterprise builds this is web content that content analysis
  // has not (or not yet) let onto the native clipboard.
  mozilla::Maybe<LocalCopyInfo> GetLocalCopyInfo();

  // The inner window id of the window the cached data came from, if the cache
  // is valid and we know it.
  mozilla::Maybe<uint64_t> GetClipboardCacheInnerWindowId(
      ClipboardType aClipboardType);
  virtual mozilla::Result<int32_t, nsresult> GetNativeClipboardSequenceNumber(
      ClipboardType aWhichClipboard) = 0;

  class ClipboardPopulatedDataSnapshot final : public nsIClipboardDataSnapshot {
   public:
    explicit ClipboardPopulatedDataSnapshot(nsITransferable* aTransferable);

    NS_DECL_ISUPPORTS
    NS_DECL_NSICLIPBOARDDATASNAPSHOT
   private:
    virtual ~ClipboardPopulatedDataSnapshot() = default;
    nsCOMPtr<nsITransferable> mTransferable;
    // List of available data types for clipboard content.
    nsTArray<nsCString> mFlavors;
  };

 protected:
  virtual ~nsBaseClipboard();

  // Implement the native clipboard behavior.
  NS_IMETHOD SetNativeClipboardData(nsITransferable* aTransferable,
                                    ClipboardType aWhichClipboard) = 0;
  virtual mozilla::Result<nsCOMPtr<nsISupports>, nsresult>
  GetNativeClipboardData(const nsACString& aFlavor,
                         ClipboardType aWhichClipboard,
                         uint64_t aThreshold = 0) = 0;
  virtual void AsyncGetNativeClipboardData(const nsACString& aFlavor,
                                           ClipboardType aWhichClipboard,
                                           GetNativeDataCallback&& aCallback);
  virtual nsresult EmptyNativeClipboardData(ClipboardType aWhichClipboard) = 0;
  virtual mozilla::Result<bool, nsresult> HasNativeClipboardDataMatchingFlavors(
      const nsTArray<nsCString>& aFlavorList,
      ClipboardType aWhichClipboard) = 0;
  virtual void AsyncHasNativeClipboardDataMatchingFlavors(
      const nsTArray<nsCString>& aFlavorList, ClipboardType aWhichClipboard,
      HasMatchingFlavorsCallback&& aCallback);

  nsTArray<nsCString> GetWebCustomFormatsFromClipboard(
      ClipboardType aWhichClipboard);

  void ClearClipboardCache(ClipboardType aClipboardType);

  /**
   *  This method is used to check if the passed in flavor is a valid flavor
   *  for nsIClipboard.
   *  @param aFlavor [in] the web custom format to be checked.
   *  @return        false, if aFlavor is a invalid, otherwise, true.
   *
   *                 mimeType is a valid flavor.
   *                 mimeType with parameters is a valid flavor.
   *                 any string not a web custom format is a valid flavor.
   *                 web custom format is a valid flavor.
   *                 web custom format with parameters is not valid flavor.
   *
   *  example:  "text/plain" -> true             // mimeType
   *            "text/plain;foo=1" -> true       // mimeType with parameters
   *            "web text/plain" -> true         // A valid web custom format
   *            "web " - false                   // Not a valid web custom
   *                                                format
   *            "web text/plain;foo=1" -> false  // A web custom format with
   *                                             // parameters is invalid
   *            "Not MimeType" -> true           // any string which is not web
   *                                             // custom format
   */
  static bool IsValidFlavor(const nsACString& aFlavor);

 private:
  // A copy waiting on a content analysis verdict before it may touch the
  // clipboard.  A newer write replaces the entry, which makes the older
  // check's completion a no-op, so the write issued last always wins
  // no matter which verdict arrives first.
  class PendingCopy final {
   public:
    NS_INLINE_DECL_REFCOUNTING(PendingCopy)

    PendingCopy(nsITransferable* aTransferable, nsIClipboardOwner* aOwner,
                mozilla::dom::WindowContext* aWindowContext,
                SetDataCompletion&& aCompletion)
        : mTransferable(aTransferable),
          mOwner(aOwner),
          mWindowContext(aWindowContext),
          mCompletion(std::move(aCompletion)) {}

    // Moves the completion out before running it, so it can only fire once
    // however many times the copy is completed or cancelled.
    void Complete(nsresult aResult) {
      if (mCompletion) {
        SetDataCompletion completion = std::move(mCompletion);
        completion(aResult);
      }
    }

    const nsCOMPtr<nsITransferable> mTransferable;
    const nsCOMPtr<nsIClipboardOwner> mOwner;
    const RefPtr<mozilla::dom::WindowContext> mWindowContext;

   private:
    ~PendingCopy() = default;
    SetDataCompletion mCompletion;
  };

  // aCheckContentAnalysis is false for the internal commit that runs once a
  // content analysis check has already allowed the copy, and for writing the
  // blocked-copy placeholder.
  nsresult SetDataImpl(nsITransferable* aTransferable,
                       nsIClipboardOwner* aOwner, ClipboardType aWhichClipboard,
                       mozilla::dom::WindowContext* aWindowContext,
                       bool aCheckContentAnalysis,
                       SetDataCompletion&& aCompletion = nullptr);

  // Whether this write has to wait for a content analysis copy verdict.
  bool NeedsCopyContentAnalysis(nsITransferable* aTransferable,
                                ClipboardType aWhichClipboard,
                                mozilla::dom::WindowContext* aWindowContext);

  // Called on the main thread when a deferred copy's verdict arrives.
  void OnCopyContentAnalysisResult(ClipboardType aWhichClipboard,
                                   PendingCopy* aPendingCopy, bool aAllowed);

  // Called on the main thread when a deferred copy gets a warn verdict the
  // user has yet to answer. Only used while the copy is cached as local-only
  // (keep_blocked_data_for_same_site). Writes the warn placeholder, keeps the
  // copy as local-only data for the copying page, and completes the copy so
  // the page can go on.
  void OnCopyContentAnalysisWarn(ClipboardType aWhichClipboard,
                                 PendingCopy* aPendingCopy,
                                 nsIContentAnalysisResponse* aResponse);

  // Replace the clipboard contents with a localized notice that the copy was
  // not permitted, or that it is waiting for the user's answer to a warning.
  // Return true if the notice is now on the clipboard.
  bool WriteCopyBlockedPlaceholder(ClipboardType aWhichClipboard);
  bool WriteCopyWarnPlaceholder(ClipboardType aWhichClipboard);
  bool WriteCopyPlaceholder(ClipboardType aWhichClipboard,
                            const nsACString& aL10nId);

  // Drops any deferred copy for this clipboard type, completing it with
  // aReason.  No-op if there isn't one.
  void CancelPendingCopy(ClipboardType aClipboardType, nsresult aReason);

  void RejectPendingAsyncSetDataRequestIfAny(ClipboardType aClipboardType);

  class AsyncSetClipboardData final : public nsIAsyncSetClipboardData {
   public:
    NS_DECL_ISUPPORTS
    NS_DECL_NSIASYNCSETCLIPBOARDDATA

    AsyncSetClipboardData(nsIClipboard::ClipboardType aClipboardType,
                          nsBaseClipboard* aClipboard,
                          mozilla::dom::WindowContext* aRequestingWindowContext,
                          nsIAsyncClipboardRequestCallback* aCallback);

   private:
    virtual ~AsyncSetClipboardData() = default;
    bool IsValid() const {
      // If this request is no longer valid, the callback should be notified.
      MOZ_ASSERT_IF(!mClipboard, !mCallback);
      return !!mClipboard;
    }
    void MaybeNotifyCallback(nsresult aResult);

    // The clipboard type defined in nsIClipboard.
    nsIClipboard::ClipboardType mClipboardType;
    // It is safe to use a raw pointer as it will be nullified (by calling
    // NotifyCallback()) once nsBaseClipboard stops tracking us. This is
    // also used to indicate whether this request is valid.
    nsBaseClipboard* mClipboard;
    RefPtr<mozilla::dom::WindowContext> mWindowContext;
    // mCallback will be nullified once the callback is notified to ensure the
    // callback is only notified once.
    nsCOMPtr<nsIAsyncClipboardRequestCallback> mCallback;
  };

  class ClipboardDataSnapshot final : public nsIClipboardDataSnapshot {
   public:
    ClipboardDataSnapshot(
        nsIClipboard::ClipboardType aClipboardType, int32_t aSequenceNumber,
        nsTArray<nsCString>&& aFlavors, bool aFromCache,
        nsBaseClipboard* aClipboard,
        mozilla::dom::WindowContext* aRequestingWindowContext);

    NS_DECL_ISUPPORTS
    NS_DECL_NSICLIPBOARDDATASNAPSHOT

   private:
    virtual ~ClipboardDataSnapshot() = default;
    bool IsValid();

    using GetDataInternalCallback = mozilla::MoveOnlyFunction<void(nsresult)>;
    void GetDataInternal(nsTArray<nsCString>&& aTypes,
                         nsTArray<nsCString>::index_type aIndex,
                         nsITransferable* aTransferable,
                         GetDataInternalCallback&& aCallback);

    // The clipboard type defined in nsIClipboard.
    const nsIClipboard::ClipboardType mClipboardType;
    // The sequence number associated with the clipboard content for this
    // request. If it doesn't match with the current sequence number in system
    // clipboard, this request targets stale data and is deemed invalid.
    const int32_t mSequenceNumber;
    // List of available data types for clipboard content.
    const nsTArray<nsCString> mFlavors;
    // Data should be read from cache.
    const bool mFromCache;
    // This is also used to indicate whether this request is still valid.
    RefPtr<nsBaseClipboard> mClipboard;
    // The requesting window, which is used for Content Analysis purposes.
    RefPtr<mozilla::dom::WindowContext> mRequestingWindowContext;
  };

  class ClipboardCache final {
   public:
    ~ClipboardCache();

    /**
     * Clear the cached transferable and notify the original clipboard owner
     * that it has lost ownership.
     */
    void Clear();
    void Update(nsITransferable* aTransferable,
                nsIClipboardOwner* aClipboardOwner, int32_t aSequenceNumber,
                mozilla::Maybe<uint64_t> aInnerWindowId) {
      // Clear first to notify the old clipboard owner.
      Clear();
      mTransferable = aTransferable;
      mClipboardOwner = aClipboardOwner;
      mSequenceNumber = aSequenceNumber;
      mInnerWindowId = std::move(aInnerWindowId);
    }

    /**
     * Cache data from aSourceWindow that is *not* on the native clipboard,
     * keyed to aSequenceNumber, the native clipboard's sequence number for
     * whatever it does hold. Like any cached data, it is dropped once that
     * sequence number changes. Unlike data we put on the native clipboard, it
     * is only served to web content in aSourceWindow's page and site (see
     * GetTransferableFor), and aClipboardOwner is not told when it is
     * cleared, as it never owned the native clipboard. Data from a private
     * window is also dropped when the last private window closes.
     *
     * Observers are notified with the topic "clipboard-local-copy-changed"
     * whenever local-only data is cached or dropped.
     *
     * aWarnRequestToken identifies the undecided warning for eWarn and is
     * ignored otherwise. If eWarn data is dropped before the user answers,
     * the warning is answered with "deny".
     */
    void UpdateLocalOnly(LocalCopyState aState, nsITransferable* aTransferable,
                         nsIClipboardOwner* aClipboardOwner,
                         int32_t aSequenceNumber,
                         mozilla::dom::WindowContext* aSourceWindow,
                         const nsACString& aWarnRequestToken = ""_ns);

    bool HasData() const { return !!mTransferable; }
    // Whether the cached data is not on the native clipboard; see
    // UpdateLocalOnly.
    bool IsLocalOnly() const { return mLocalOnly.isSome(); }
    // The transferable we put on the native clipboard. Null if the cached data
    // is local-only.
    nsITransferable* GetTransferable() const {
      return IsLocalOnly() ? nullptr : mTransferable.get();
    }
    nsIClipboardOwner* GetClipboardOwner() const {
      return IsLocalOnly() ? nullptr : mClipboardOwner.get();
    }
    // The cached transferable if aRequestingWindow may read it, else null.
    nsITransferable* GetTransferableFor(
        mozilla::dom::WindowGlobalParent* aRequestingWindow) const;
    // The principal of whoever the cached data came from, if known.
    nsIPrincipal* GetDataPrincipal() const;
    int32_t GetSequenceNumber() const { return mSequenceNumber; }
    mozilla::Maybe<uint64_t> GetInnerWindowId() const { return mInnerWindowId; }
    // Fills aTransferable from the cached transferable. Callers must check
    // that the requester may read it (GetTransferableFor) first.
    nsresult GetData(nsITransferable* aTransferable) const;
    mozilla::Maybe<LocalCopyInfo> GetLocalCopyInfo() const;
    // What is needed to commit local-only data to the native clipboard later.
    // Null if the cached data isn't local-only.
    nsIClipboardOwner* GetLocalOnlyClipboardOwner() const {
      return IsLocalOnly() ? mClipboardOwner.get() : nullptr;
    }
    mozilla::dom::WindowContext* GetLocalOnlySourceWindow() const {
      return IsLocalOnly() ? mLocalOnly->mSourceWindow.get() : nullptr;
    }

   private:
    // Clear() without notifying observers of local-only data being dropped.
    // Returns whether there was local-only data.
    bool Reset();
    static void NotifyLocalCopyChanged();
    void StartObservingPrivateBrowsingExit();
    void StopObservingPrivateBrowsingExit();

    struct LocalOnly {
      LocalCopyState mState;
      RefPtr<mozilla::dom::WindowContext> mSourceWindow;
      // Inner window id of the source window's top-level document.
      uint64_t mSourceTopInnerWindowId = 0;
      nsCOMPtr<nsIPrincipal> mSourcePrincipal;
      nsCString mWarnRequestToken;
    };

    nsCOMPtr<nsITransferable> mTransferable;
    nsCOMPtr<nsIClipboardOwner> mClipboardOwner;
    int32_t mSequenceNumber = -1;
    mozilla::Maybe<uint64_t> mInnerWindowId;
    mozilla::Maybe<LocalOnly> mLocalOnly;
    bool mObservingPrivateBrowsingExit = false;
  };

  void MaybeRetryGetAvailableFlavors(
      const nsTArray<nsCString>& aFlavorList,
      nsIClipboard::ClipboardType aWhichClipboard,
      nsIClipboardGetDataSnapshotCallback* aCallback, int32_t aRetryCount,
      mozilla::dom::WindowContext* aRequestingWindowContext);

  // Return clipboard cache if the cached data is valid, otherwise clear the
  // cached data and returns null.
  ClipboardCache* GetClipboardCacheIfValid(ClipboardType aClipboardType);

  // Return the clipboard cache if it is valid and aRequestingWindowContext may
  // read from it: local-only data only for its source page, and data we put
  // on the native clipboard only when widget.clipboard.use-cached-data.enabled
  // is on. Otherwise returns null.
  ClipboardCache* GetClipboardCacheForReading(
      ClipboardType aClipboardType,
      mozilla::dom::WindowContext* aRequestingWindowContext);

  mozilla::Result<nsTArray<nsCString>, nsresult> GetFlavorsFromClipboardCache(
      ClipboardType aClipboardType);

  nsresult GetDataImpl(nsITransferable* aTransferable, uint64_t aThreshold,
                       ClipboardType aWhichClipboard,
                       mozilla::dom::WindowContext* aWindowContext,
                       bool aCheckContentAnalysis);

  // Whether any string data in aTransferable is larger than aThreshold bytes.
  static bool TransferableExceedsThreshold(nsITransferable* aTransferable,
                                           uint64_t aThreshold);
  void RequestUserConfirmation(ClipboardType aClipboardType,
                               const nsTArray<nsCString>& aFlavorList,
                               mozilla::dom::WindowContext* aWindowContext,
                               nsIPrincipal* aRequestingPrincipal,
                               nsIClipboardGetDataSnapshotCallback* aCallback);

  already_AddRefed<nsIClipboardDataSnapshot>
  MaybeCreateGetRequestFromClipboardCache(
      const nsTArray<nsCString>& aFlavorList, ClipboardType aClipboardType,
      mozilla::dom::WindowContext* aRequestingWindowContext);

  // Clean up data in transferable for posting to clipboard or dragging.  This
  // guarantees that text data does not include NUL characters.
  static nsresult SanitizeForClipboard(nsITransferable* aTransferable);

  // Track the pending request for each clipboard type separately. And only need
  // to track the latest request for each clipboard type as the prior pending
  // request will be canceled when a new request is made.
  mozilla::Array<RefPtr<AsyncSetClipboardData>,
                 nsIClipboard::kClipboardTypeCount>
      mPendingWriteRequests;

  mozilla::Array<mozilla::UniquePtr<ClipboardCache>,
                 nsIClipboard::kClipboardTypeCount>
      mCaches;

  // Copies awaiting a content analysis verdict. Only the
  // global clipboard is ever analyzed.
  RefPtr<PendingCopy> mPendingCopy;
  const mozilla::dom::ClipboardCapabilities mClipboardCaps;
  bool mIgnoreEmptyNotification = false;

  // True when SetNativeClipboardData or EmptyNativeClipboardData is running.
  bool mMutatingNativeClipboard = false;
};

#endif  // nsBaseClipboard_h_
