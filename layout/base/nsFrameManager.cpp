/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* storage of the frame tree and information about it */

#include "nsFrameManager.h"

#include "ChildIterator.h"
#include "GeckoProfiler.h"
#include "mozilla/AbsoluteContainingBlock.h"
#include "mozilla/ComputedStyle.h"
#include "mozilla/PresShell.h"
#include "mozilla/PresState.h"
#include "mozilla/ScrollContainerFrame.h"
#include "mozilla/ViewportFrame.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/Element.h"
#include "nsContainerFrame.h"
#include "nsError.h"
#include "nsILayoutHistoryState.h"
#include "nsPlaceholderFrame.h"
#include "nsWindowSizes.h"
#include "nscore.h"
#include "plhash.h"

using namespace mozilla;
using namespace mozilla::dom;

//----------------------------------------------------------------------

nsFrameManager::~nsFrameManager() {
  NS_ASSERTION(!mPresShell, "nsFrameManager::Destroy never called");
}

void nsFrameManager::SetRootFrame(ViewportFrame* aRootFrame) {
  MOZ_ASSERT(aRootFrame, "The root frame should be valid!");
  MOZ_ASSERT(!mRootFrame, "We should set a root frame only once!");
  mRootFrame = aRootFrame;
}

void nsFrameManager::Destroy() {
  NS_ASSERTION(mPresShell, "Frame manager already shut down.");

  // Destroy the frame hierarchy.
  mPresShell->SetIgnoreFrameDestruction(true);

  if (mRootFrame) {
    FrameDestroyContext context(mPresShell);
    mRootFrame->Destroy(context);
    mRootFrame = nullptr;
  }

  mPresShell = nullptr;
}

//----------------------------------------------------------------------
void nsFrameManager::AppendFrames(nsContainerFrame* aParentFrame,
                                  FrameChildListID aListID,
                                  nsFrameList&& aFrameList) {
  if (aParentFrame->IsAbsoluteContainer() &&
      aListID == FrameChildListID::Absolute) {
    aParentFrame->GetAbsoluteContainingBlock()->AppendFrames(
        aParentFrame, aListID, std::move(aFrameList));
  } else {
    aParentFrame->AppendFrames(aListID, std::move(aFrameList));
  }
}

void nsFrameManager::InsertFrames(nsContainerFrame* aParentFrame,
                                  FrameChildListID aListID,
                                  nsIFrame* aPrevFrame,
                                  nsFrameList&& aFrameList) {
  MOZ_ASSERT(
      !aPrevFrame ||
          (!aPrevFrame->GetNextContinuation() ||
           (aPrevFrame->GetNextContinuation()->HasAnyStateBits(
                NS_FRAME_IS_OVERFLOW_CONTAINER) &&
            !aPrevFrame->HasAnyStateBits(NS_FRAME_IS_OVERFLOW_CONTAINER))),
      "aPrevFrame must be the last continuation in its chain!");

  if (aParentFrame->IsAbsoluteContainer() &&
      aListID == FrameChildListID::Absolute) {
    aParentFrame->GetAbsoluteContainingBlock()->InsertFrames(
        aParentFrame, aListID, aPrevFrame, std::move(aFrameList));
  } else {
    aParentFrame->InsertFrames(aListID, aPrevFrame, nullptr,
                               std::move(aFrameList));
  }
}

void nsFrameManager::RemoveFrame(DestroyContext& aContext,
                                 FrameChildListID aListID,
                                 nsIFrame* aOldFrame) {
  // In case the reflow doesn't invalidate anything since it just leaves
  // a gap where the old frame was, we invalidate it here.  (This is
  // reasonably likely to happen when removing a last child in a way
  // that doesn't change the size of the parent.)
  // This has to sure to invalidate the entire overflow rect; this
  // is important in the presence of absolute positioning
  aOldFrame->InvalidateFrameForRemoval();

  NS_ASSERTION(!aOldFrame->GetPrevContinuation() ||
                   // exception for
                   // nsCSSFrameConstructor::RemoveFloatingFirstLetterFrames
                   aOldFrame->IsTextFrame(),
               "Must remove first continuation.");
  NS_ASSERTION(!(aOldFrame->HasAnyStateBits(NS_FRAME_OUT_OF_FLOW) &&
                 aOldFrame->GetPlaceholderFrame()),
               "Must call RemoveFrame on placeholder for out-of-flows.");
  nsContainerFrame* parentFrame = aOldFrame->GetParent();
  if (parentFrame->IsAbsoluteContainer() &&
      aListID == FrameChildListID::Absolute) {
    parentFrame->GetAbsoluteContainingBlock()->RemoveFrame(aContext, aListID,
                                                           aOldFrame);
  } else {
    parentFrame->RemoveFrame(aContext, aListID, aOldFrame);
  }
}

void nsFrameManager::CaptureFrameState(nsIFrame* aFrame,
                                       nsILayoutHistoryState* aState,
                                       CaptureStateFlags aFlags) {
  MOZ_ASSERT(aFrame);
  MOZ_ASSERT(aState);

  if (ScrollContainerFrame* scrollFrame = do_QueryFrame(aFrame)) {
    scrollFrame->SaveState(aFlags, aState);
  }

  // Now capture state recursively for the frame hierarchy rooted at aFrame
  for (const auto& childList : aFrame->ChildLists()) {
    for (nsIFrame* child : childList.mList) {
      if (child->HasAnyStateBits(NS_FRAME_OUT_OF_FLOW)) {
        // We'll pick it up when we get to its placeholder
        continue;
      }
      // Make sure to walk through placeholders as needed, so that we
      // save state for out-of-flows which may not be our descendants
      // themselves but whose placeholders are our descendants.
      nsIFrame* realChild = nsPlaceholderFrame::GetRealFrameFor(child);
      // GetRealFrameFor should theoretically never return null here (and its
      // helper has an assertion to enforce this); but we've got known fuzzer
      // testcases where it does return null (in non-debug builds that make it
      // past the aforementioned assertion) due to weird situations with
      // out-of-flows and fragmentation. We handle that unexpected situation by
      // silently skipping this frame, rather than crashing.
      if (MOZ_LIKELY(realChild)) {
        CaptureFrameState(realChild, aState, aFlags);
      }
    }
  }
}

void nsFrameManager::RestoreFrameStateFor(nsIFrame* aFrame,
                                          nsILayoutHistoryState* aState) {
  MOZ_ASSERT(aFrame);
  MOZ_ASSERT(aState);

  if (!aState->HasStates()) {
    // Nothing to restore.
    return;
  }

  // Only restore state for scroll frames
  if (ScrollContainerFrame* scrollFrame = do_QueryFrame(aFrame)) {
    scrollFrame->RestoreState(aState);
  }
}

void nsFrameManager::AddSizeOfIncludingThis(nsWindowSizes& aSizes) const {
  aSizes.mLayoutPresShellSize += aSizes.mState.mMallocSizeOf(this);
}
