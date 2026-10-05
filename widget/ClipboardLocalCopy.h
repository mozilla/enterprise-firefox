/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_widget_ClipboardLocalCopy_h
#define mozilla_widget_ClipboardLocalCopy_h

#include "mozilla/Maybe.h"
#include "mozilla/RefPtr.h"
#include "nsCOMPtr.h"
#include "nsString.h"

class nsIClipboardOwner;
class nsIPrincipal;
class nsITransferable;

namespace mozilla::dom {
class WindowContext;
class WindowGlobalParent;
}  // namespace mozilla::dom

namespace mozilla::widget {

/**
 * Data web content copied that is not (or not yet) on the system clipboard
 * because of content analysis, kept so the copying tab can still paste it
 * inside Firefox.
 *
 * The slot goes through up to three states. While a copy awaits its verdict
 * (ePending), the data is remembered, so the copying page need not wait for the
 * agent. If the verdict blocks the copy (eBlocked), the system clipboard gets a
 * placeholder notice and the data is still remembered. If the verdict is a
 * warning the user has yet to answer (eWarn), a different placeholder notice is
 * written and the data, together with what is needed to commit it later, is
 * kept until the user releases it from the DLP panel (the copy then lands on
 * the system clipboard) or the clipboard moves on.
 *
 * Whatever the state, the data is current only while its sequence number is
 * still the clipboard's: anything else landing on the clipboard supersedes it.
 * It is only ever served to web content in the same tab and page as the copying
 * window, and callers still run the paste content analysis check on what they
 * get.
 *
 * Every change to the slot is announced to observers with the topic
 * "clipboard-local-copy-changed" (no subject), so the front end can show the
 * slot's state without polling.
 *
 * Only the global clipboard is analyzed, so nsBaseClipboard holds one of
 * these. It is only ever populated in Enterprise builds (MOZ_ENTERPRISE);
 * elsewhere it stays empty and every read falls through to the native
 * clipboard.
 */
class ClipboardLocalCopy final {
 public:
  enum class State : uint8_t { ePending, eWarn, eBlocked };

  ClipboardLocalCopy() = default;
  ~ClipboardLocalCopy();

  ClipboardLocalCopy(const ClipboardLocalCopy&) = delete;
  ClipboardLocalCopy& operator=(const ClipboardLocalCopy&) = delete;

  // Remembers the passed-in data.
  // aWarnRequestToken identifies the undecided warn verdict for eWarn and is
  // ignored otherwise.
  void Remember(State aState, nsITransferable* aTransferable,
                nsIClipboardOwner* aOwner, int32_t aSequenceNumber,
                dom::WindowContext* aSourceWindow,
                const nsACString& aWarnRequestToken = ""_ns);

  // Forgets the data.
  void Clear();

  // Whether remembered data is current to aCurrentSequenceNumber.
  bool IsCurrent(int32_t aCurrentSequenceNumber);

  bool IsEmpty() const { return mData.isNothing(); }

  // The accessors below are only meaningful right after IsCurrent() returned
  // true.
  State GetState() const;
  nsITransferable* Transferable() const;
  nsIClipboardOwner* Owner() const;
  dom::WindowContext* SourceWindow() const;
  const nsCString& WarnRequestToken() const;
  int32_t SequenceNumber() const;
  uint64_t SourceInnerWindowId() const;
  nsIPrincipal* SourcePrincipal() const;

  // The start of the copy's text/plain flavor for the user to recognize it by
  // in the DLP panel.
  void GetPreviewText(uint32_t aMaxCodePoints, nsAString& aPreview) const;

  // The remembered data if aRequestingWindow's document is in the same tab
  // and same-site with the copying window, else null. Does not check currency;
  // callers must verify IsCurrent() first.
  already_AddRefed<nsITransferable> GetDataFor(
      dom::WindowGlobalParent* aRequestingWindow) const;

 private:
  struct Data {
    State mState = State::ePending;
    nsCOMPtr<nsITransferable> mTransferable;
    nsCOMPtr<nsIClipboardOwner> mOwner;
    RefPtr<dom::WindowContext> mSourceWindow;
    nsCString mWarnRequestToken;
    int32_t mSequenceNumber = -1;
    uint64_t mSourceInnerWindowId = 0;
    // Inner window id of the copying window's top-level document
    uint64_t mSourceTopInnerWindowId = 0;
    nsCOMPtr<nsIPrincipal> mSourcePrincipal;
  };

  // Forgets the data without telling observers; returns whether there was
  // any.
  bool Reset();
  void NotifyChanged();

  // When a private session ends, we clear any local data that came from a
  // private session. This isn't strictly necessary, but Firefox has a guarantee
  // that nothing from a private session outlives the session.
  void StartObservingPrivateBrowsingExit();
  void StopObservingPrivateBrowsingExit();

  Maybe<Data> mData;
  // Avoid having to guard with a mutex
  bool mObservingPrivateBrowsingExit MOZ_GUARDED_BY(sMainThreadCapability) =
      false;
};

}  // namespace mozilla::widget

#endif  // mozilla_widget_ClipboardLocalCopy_h
