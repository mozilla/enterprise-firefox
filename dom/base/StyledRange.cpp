/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/StyledRange.h"

#include "AbstractRange.h"
#include "nsCycleCollectionParticipant.h"

namespace mozilla::dom {

StyledRange::StyledRange(AbstractRange* aRange, TextRangeStyle aStyle)
    : mRange(aRange), mTextRangeStyle(aStyle) {}

void ImplCycleCollectionTraverse(nsCycleCollectionTraversalCallback& aCallback,
                                 StyledRangeCollection& aField,
                                 const char* aName, uint32_t aFlags) {
  for (size_t i = 0; i < aField.Length(); ++i) {
    CycleCollectionNoteChild(aCallback, aField.GetAbstractRangeAt(i),
                             "mRanges[i]", aFlags);
  }
}
void StyledRangeCollection::AppendElement(StyledRange&& aRange) {
  AddStyle(*mRanges.AppendElement(std::move(aRange.mRange)),
           aRange.mTextRangeStyle);
}
void StyledRangeCollection::AppendElement(const StyledRange& aRange) {
  AddStyle(*mRanges.AppendElement(aRange.mRange), aRange.mTextRangeStyle);
}

void StyledRangeCollection::InsertElementAt(size_t aIndex,
                                            StyledRange&& aRange) {
  AddStyle(*mRanges.InsertElementAt(aIndex, std::move(aRange.mRange)),
           aRange.mTextRangeStyle);
}

void StyledRangeCollection::InsertElementAt(size_t aIndex,
                                            const StyledRange& aRange) {
  AddStyle(*mRanges.InsertElementAt(aIndex, aRange.mRange),
           aRange.mTextRangeStyle);
}

void StyledRangeCollection::InsertElementsAt(
    size_t aIndex, const nsTArray<StyledRange>& aStyledRanges) {
  for (size_t i = 0; i < aStyledRanges.Length(); ++i) {
    InsertElementAt(aIndex + i, aStyledRanges[i]);
  }
}

bool StyledRangeCollection::RemoveElement(const AbstractRange* aRange) {
  for (size_t i = 0; i < mRanges.Length(); ++i) {
    if (mRanges[i] == aRange) {
      RemoveElementAt(i);
      return true;
    }
  }
  return false;
}

void StyledRangeCollection::RemoveElementAt(size_t aIndex) {
  mozilla::dom::AbstractRange* range = mRanges[aIndex];
  RemoveStyle(range);
  mRanges.RemoveElementAt(aIndex);
}

void StyledRangeCollection::RemoveElementsAt(size_t aStart, size_t aCount) {
  for (size_t i = aStart; i < aStart + aCount; ++i) {
    RemoveStyle(mRanges[i]);
  }
  mRanges.RemoveElementsAt(aStart, aCount);
}

void StyledRangeCollection::Clear() {
  mRangeStyleData.Clear();
  mRanges.Clear();
}

StyledRange StyledRangeCollection::ExtractElementAt(size_t aIndex) {
  mozilla::dom::AbstractRange* range = mRanges[aIndex];
  StyledRange result(range);
  if (auto* style = FindStyleForRange(range)) {
    result.mTextRangeStyle = *style;
  }
  RemoveElementAt(aIndex);
  return result;
}

void StyledRangeCollection::AddStyle(AbstractRange* aRange,
                                     const TextRangeStyle& aStyle) {
  mRangeStyleData.InsertOrUpdate(aRange, aStyle);
}

void StyledRangeCollection::RemoveStyle(AbstractRange* aRange) {
  mRangeStyleData.Remove(aRange);
}

mozilla::TextRangeStyle* StyledRangeCollection::FindStyleForRange(
    AbstractRange* aRange) {
  if (!aRange) {
    return nullptr;
  }

  return mRangeStyleData.Lookup(aRange).DataPtrOrNull();
}
}  // namespace mozilla::dom
