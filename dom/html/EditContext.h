/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_EditContext_h
#define mozilla_dom_EditContext_h

#include "mozilla/DOMEventTargetHelper.h"
#include "mozilla/dom/EditContextBinding.h"

class nsTextNode;

namespace mozilla::dom {

class EditContext final : public DOMEventTargetHelper {
 public:
  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_CYCLE_COLLECTION_CLASS_INHERITED(EditContext, DOMEventTargetHelper)

  JSObject* WrapObject(JSContext* aCx,
                       JS::Handle<JSObject*> aGivenProto) override;

  static already_AddRefed<EditContext> Constructor(const GlobalObject& aGlobal,
                                                   const EditContextInit& aInit,
                                                   ErrorResult& aRv);

  void UpdateText(uint32_t aRangeStart, uint32_t aRangeEnd,
                  const nsAString& aText, ErrorResult& aRv);
  void UpdateSelection(uint32_t aStart, uint32_t aEnd);
  void UpdateControlBounds(DOMRect& aControlBounds);
  void UpdateSelectionBounds(DOMRect& aSelectionBounds);
  void UpdateCharacterBounds(
      uint32_t aRangeStart,
      const Sequence<OwningNonNull<DOMRect>>& aCharacterBounds);
  void AttachedElements(nsTArray<RefPtr<nsGenericHTMLElement>>& aRetVal) {
    if (mAssociatedElement) {
      aRetVal.AppendElement(mAssociatedElement);
    }
  }

  void GetText(nsAString& aText) const;
  void GetTextSubstring(uint32_t aStart, uint32_t aEnd, nsAString& aText);
  uint32_t TextLength() const;
  uint32_t SelectionStart() const { return mSelectionStart; }
  uint32_t SelectionEnd() const { return mSelectionEnd; }

  // Selection start, clamped to <= length of text
  uint32_t SelectionStartClamped() const {
    // XXX: Perhaps selectionStart/End should already be clamped.
    //      See https://github.com/w3c/edit-context/issues/88
    return std::min(SelectionStart(), TextLength());
  }
  // Selection end, clamped to <= length of text
  uint32_t SelectionEndClamped() const {
    // XXX: Perhaps selectionStart/End should already be clamped.
    //      See https://github.com/w3c/edit-context/issues/88
    return std::min(SelectionEnd(), TextLength());
  }
  uint32_t CharacterBoundsRangeStart() const {
    return mCodepointRectsStartIndex;
  }
  void CharacterBounds(nsTArray<RefPtr<DOMRect>>& aRetVal) const;

  nsGenericHTMLElement* GetAssociatedElement() const {
    return mAssociatedElement;
  }
  void SetAssociatedElement(nsGenericHTMLElement* aElement) {
    mAssociatedElement = aElement;
  }

  // Anonymous <div> element that holds the text being edited.
  nsGenericHTMLElement& TextContainer() { return *mTextContainer; }
  nsTextNode& TextNode() { return *mText; }

  // Get writing mode of associated element.
  mozilla::WritingMode WritingMode() const;

  // https://w3c.github.io/edit-context/#dfn-deactivate-an-editcontext
  MOZ_CAN_RUN_SCRIPT void Deactivate();

  IMPL_EVENT_HANDLER(characterboundsupdate);
  IMPL_EVENT_HANDLER(compositionstart);
  IMPL_EVENT_HANDLER(compositionend);
  IMPL_EVENT_HANDLER(textformatupdate);
  IMPL_EVENT_HANDLER(textupdate);

  static EditContext* GetForElement(const Element& aElement);
  static void SetForElement(const Element& aElement, EditContext* aEditContext);
  /*
   * Returns whether there is any EditContext attached to any element
   * in this process.
   */
  static bool IsAnyAttached();

  bool IsActive() const;

  MOZ_CAN_RUN_SCRIPT void UpdateTextAndFireEvent(uint32_t aStart, uint32_t aEnd,
                                                 const nsAString& aString);
  MOZ_CAN_RUN_SCRIPT void StartComposition(
      const WidgetCompositionEvent& aEvent);
  MOZ_CAN_RUN_SCRIPT void EndComposition(const WidgetCompositionEvent& aEvent);

  MOZ_CAN_RUN_SCRIPT void FireTextFormatUpdate(const TextRangeArray* aRanges,
                                               uint32_t aCompositionOffset);
  MOZ_CAN_RUN_SCRIPT nsresult FireCharacterBoundsUpdateAndGetRects(
      uint32_t aStart, uint32_t aEnd, nsTArray<LayoutDeviceIntRect>& aRects);

  bool WasTextNextToCaretChangedByTextUpdateHandler() const {
    return mTextNextToCaretChangedByTextUpdateHandler;
  }

 private:
  EditContext(nsIGlobalObject* aGlobalObject, const EditContextInit& aInit,
              ErrorResult& aRv);
  ~EditContext() = default;

  using Rect = gfx::RectTyped<CSSPixel, double>;

  RefPtr<DOMRect> ToDOMRect(const Rect& copy) const;
  Rect ToRect(const DOMRect& rect) const;

  RefPtr<nsGenericHTMLElement> mAssociatedElement;
  RefPtr<nsGenericHTMLElement> mTextContainer;
  nsTArray<Rect> mCodepointRects;
  Rect mControlBounds;
  Rect mSelectionBounds;
  RefPtr<nsTextNode> mText;
  uint32_t mSelectionStart = 0;
  uint32_t mSelectionEnd = 0;
  uint32_t mCodepointRectsStartIndex = 0;
  bool mIsComposing = false;
  bool mTextNextToCaretChangedByTextUpdateHandler = false;
  bool mExpectingCharacterBounds = false;
};

}  // namespace mozilla::dom

#endif
