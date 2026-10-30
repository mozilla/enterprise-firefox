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
#include "nsIClipboardOwner.h"
#include "nsITransferable.h"

extern mozilla::LazyLogModule gWidgetClipboardLog;
#define MOZ_CLIPBOARD_LOG(...) \
  MOZ_LOG(gWidgetClipboardLog, mozilla::LogLevel::Debug, (__VA_ARGS__))
#define MOZ_CLIPBOARD_LOG_ENABLED() \
  MOZ_LOG_TEST(gWidgetClipboardLog, mozilla::LogLevel::Debug)

class nsIContentAnalysisLocalCopyInfo;
class nsIContentAnalysisResponse;
class nsITransferable;
class nsIClipboardOwner;
class nsIPrincipal;
class nsIWidget;

namespace mozilla::dom {
class WindowContext;
}  // namespace mozilla::dom

#define NS_BASECLIPBOARD_IID \
  {0x9b45fabf, 0x4072, 0x45b5, {0xaf, 0xb4, 0x8c, 0x68, 0x62, 0x07, 0x0e, 0xe9}}

/**
 * A base clipboard class for all platform, so that they can share the same
 * implementation.
 */
class nsBaseClipboard : public nsIClipboard {
 public:
  NS_INLINE_DECL_STATIC_IID(NS_BASECLIPBOARD_IID)

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
  // clipboard (see ClipboardCache::UpdateNotOnNativeClipboard).
  nsresult GetDataWithoutContentAnalysis(
      nsITransferable* aTransferable, ClipboardType aWhichClipboard,
      mozilla::dom::WindowContext* aRequestingWindowContext);

  using GetNativeDataCallback = mozilla::MoveOnlyFunction<void(
      mozilla::Result<nsCOMPtr<nsISupports>, nsresult>)>;
  using HasMatchingFlavorsCallback = mozilla::MoveOnlyFunction<void(
      mozilla::Result<nsTArray<nsCString>, nsresult>)>;
  using GetWebCustomFormatsCallback = mozilla::MoveOnlyFunction<void(
      mozilla::Result<nsTArray<nsCString>, nsresult>)>;

  // What the global clipboard cache is keeping for a copying page because
  // content analysis has not (or not yet) let the copy onto the native
  // clipboard, or null if it is keeping nothing. Only Enterprise builds keep
  // copies.
  already_AddRefed<nsIContentAnalysisLocalCopyInfo> GetKeptCopyInfo();

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
  //
  // In Enterprise builds the copy may also be kept in the global clipboard
  // cache for the copying page (see KeepInClipboardCache), while its verdict
  // is pending, while the user has yet to answer a warning about it, and after
  // the verdict blocks it. The copy is then the cache entry's owner, which is
  // how it hears that the kept data was dropped, and it stays in mPendingCopy
  // until then.
  class PendingCopy final : public nsIClipboardOwner {
   public:
    NS_DECL_ISUPPORTS
    NS_DECL_NSICLIPBOARDOWNER

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

    // What a kept copy is waiting for.
    enum class KeptState : uint8_t {
      // Its content analysis verdict.
      ePending,
      // The user's answer to a content analysis warning about the copy.
      eWarn,
      // Nothing: content analysis blocked the copy.
      eBlocked,
    };

    const nsCOMPtr<nsITransferable> mTransferable;
    const nsCOMPtr<nsIClipboardOwner> mOwner;
    const RefPtr<mozilla::dom::WindowContext> mWindowContext;
    // The clipboard whose cache is keeping this copy, if any. The clipboard
    // drops the kept data, which resets this, before it goes away.
    nsBaseClipboard* mKeptBy = nullptr;
    KeptState mKeptState = KeptState::ePending;
    // Identifies the undecided warning while mKeptState is eWarn.
    nsCString mWarnRequestToken;

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

  // Writes aTransferable to the native clipboard without touching the
  // clipboard cache, and returns the native clipboard's new sequence number.
  mozilla::Result<int32_t, nsresult> WriteNativeClipboardData(
      nsITransferable* aTransferable, ClipboardType aWhichClipboard);

  // Whether this write has to wait for a content analysis copy verdict.
  bool NeedsCopyContentAnalysis(nsITransferable* aTransferable,
                                ClipboardType aWhichClipboard,
                                mozilla::dom::WindowContext* aWindowContext);

  // Called on the main thread when a deferred copy's verdict arrives.
  void OnCopyContentAnalysisResult(ClipboardType aWhichClipboard,
                                   PendingCopy* aPendingCopy, bool aAllowed);

  // Called on the main thread when a deferred copy that is kept in the
  // clipboard cache gets a warn verdict the user has yet to answer. Writes the
  // warn placeholder, keeps the copy for the copying page, and completes the
  // copy so the page can go on.
  void OnCopyContentAnalysisWarn(ClipboardType aWhichClipboard,
                                 PendingCopy* aPendingCopy,
                                 nsIContentAnalysisResponse* aResponse);

  // Replaces the clipboard contents with a localized notice that the copy was
  // not permitted.
  void WriteCopyBlockedPlaceholder(ClipboardType aWhichClipboard);

  // Writes the localized notice aL10nId to the native clipboard in place of
  // the copy the global clipboard cache is keeping, which stays valid for the
  // copying page. Returns false if the notice could not be written.
  bool WriteCopyPlaceholderForKeptCopy(const nsACString& aL10nId);

  // Caches aPendingCopy's data for its page in the global clipboard cache, so
  // that the page can paste it without waiting for the verdict. Returns false
  // if the data could not be cached.
  bool KeepInClipboardCache(PendingCopy* aPendingCopy);

  // Called when the global clipboard cache drops aPendingCopy's kept data.
  void OnKeptCopyDropped(PendingCopy* aPendingCopy);

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
     * Cache data from aSourceWindow before, or instead of, writing it to the
     * native clipboard. It is keyed to aSequenceNumber, and like
     * any cached data it is dropped once that sequence number changes. Unlike
     * data we put on the native clipboard, it is only served to web content in
     * aSourceWindow's page and site (see MayRead), whatever
     * widget.clipboard.use-cached-data.enabled says, and it is dropped when
     * the last private window closes if it came from one.
     *
     * Returns false, leaving the cache empty, if aSourceWindow's page can't be
     * identified.
     */
    bool UpdateNotOnNativeClipboard(nsITransferable* aTransferable,
                                    nsIClipboardOwner* aClipboardOwner,
                                    int32_t aSequenceNumber,
                                    mozilla::dom::WindowContext* aSourceWindow);

    /**
     * The cache normally holds exactly what is on the native clipboard, and is
     * keyed to the native sequence number that data got when we wrote it.
     * Data that is not on the native clipboard (see
     * UpdateNotOnNativeClipboard) is instead keyed to whatever the native
     * clipboard holds, so writing something else to the native clipboard
     * ourselves (such as a notice saying why the cached data isn't there)
     * would otherwise invalidate it. Rekey keeps such data valid for its
     * readers under aSequenceNumber, the number the native clipboard got for
     * our write. Any later change to the native clipboard still drops it.
     */
    void Rekey(int32_t aSequenceNumber);

    bool HasData() const { return !!mTransferable; }
    // Whether the cached data is what the native clipboard holds, as opposed
    // to data cached with UpdateNotOnNativeClipboard.
    bool IsOnNativeClipboard() const { return mReadRestriction.isNothing(); }
    // Whether aRequestingWindow may read the cached data. Always true for data
    // that is on the native clipboard.
    bool MayRead(mozilla::dom::WindowContext* aRequestingWindow) const;
    nsITransferable* GetTransferable() const { return mTransferable; }
    nsIClipboardOwner* GetClipboardOwner() const { return mClipboardOwner; }
    // The principal of whoever the cached data came from, if known.
    nsIPrincipal* GetDataPrincipal() const;
    int32_t GetSequenceNumber() const { return mSequenceNumber; }
    mozilla::Maybe<uint64_t> GetInnerWindowId() const { return mInnerWindowId; }
    // Fills aTransferable from the cached transferable. Callers must check
    // that the requester may read it (MayRead) first.
    nsresult GetData(nsITransferable* aTransferable) const;

   private:
    void StartObservingPrivateBrowsingExit();
    void StopObservingPrivateBrowsingExit();

    // Who may read cached data that is not on the native clipboard: web
    // content in the page and site it came from.
    struct ReadRestriction {
      // Inner window id of the source window's top-level document.
      uint64_t mSourceTopInnerWindowId = 0;
      nsCOMPtr<nsIPrincipal> mSourcePrincipal;
    };

    nsCOMPtr<nsITransferable> mTransferable;
    nsCOMPtr<nsIClipboardOwner> mClipboardOwner;
    int32_t mSequenceNumber = -1;
    mozilla::Maybe<uint64_t> mInnerWindowId;
    mozilla::Maybe<ReadRestriction> mReadRestriction;
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
  // read from it: data that is not on the native clipboard only for its source
  // page, and data we put on the native clipboard only when
  // widget.clipboard.use-cached-data.enabled is on. Otherwise returns null.
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
