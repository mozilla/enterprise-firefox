/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, staticHtml, literal } from "../vendor/lit.all.mjs";
import { MozLitElement } from "../lit-utils.mjs";

export const GROUP_TYPES = {
  list: "list",
  reorderable: "reorderable-list",
};

/**
 * An element used to group combinations of moz-box-item, moz-box-link, and
 * moz-box-button elements and provide the expected styles.
 *
 * @tagname moz-box-group
 * @property {string} type
 *   The type of the group, either "list", "reorderable-list", or undefined.
 *   Note that "reorderable-list" only works with moz-box-item elements for now.
 * @slot default - Slot for rendering various moz-box-* elements.
 * @slot <index> - Slots used to assign moz-box-* elements to <li> elements when
 *   the group is type="list".
 * @fires reorder
 *  Fired when items are reordered via drag-and-drop or keyboard shortcuts.
 *  The detail object contains draggedElement, targetElement, position, draggedIndex, and targetIndex.
 */

export default class MozBoxGroup extends MozLitElement {
  #tabbable = true;

  static properties = {
    type: { type: String },
    listItems: { type: Array, state: true },
  };

  static queries = {
    reorderableList: "moz-reorderable-list",
    headerSlot: "slot[name='header']",
    footerSlot: "slot[name='footer']",
  };

  constructor() {
    super();
    this.listItems = [];
    this.listMutationObserver = new MutationObserver(
      this.updateItems.bind(this)
    );
  }

  firstUpdated(changedProperties) {
    super.firstUpdated(changedProperties);
    this.listMutationObserver.observe(this, {
      attributeFilter: ["hidden"],
      subtree: true,
      childList: true,
    });
    this.updateItems();
  }

  contentTemplate() {
    if (this.type == GROUP_TYPES.reorderable) {
      return html`<moz-reorderable-list
        class="scroll-container"
        itemselector="moz-box-item"
        dragselector=".handle"
        @reorder=${this.handleReorder}
      >
        ${this.slotTemplate()}
      </moz-reorderable-list>`;
    }
    return this.slotTemplate();
  }

  slotTemplate() {
    if (this.type == GROUP_TYPES.list || this.type == GROUP_TYPES.reorderable) {
      let listTag =
        this.type == GROUP_TYPES.reorderable ? literal`ol` : literal`ul`;
      return staticHtml`<${listTag}
          tabindex="-1"
          class="list scroll-container"
          aria-orientation="vertical"
          @keydown=${this.handleKeydown}
          @focusin=${this.handleFocus}
          @focusout=${this.handleBlur}
        >
          ${this.listItems.map((_, i) => {
            return html`<li>
              <slot name=${i}></slot>
            </li> `;
          })}
        </${listTag}>
        <slot hidden></slot>`;
    }
    return html`<div class="scroll-container" tabindex="-1">
      <slot></slot>
    </div>`;
  }

  /**
   * Handles reordering of items in the list.
   *
   * @param {object} event - Event object or wrapper containing detail from moz-reorderable-list.
   * @param {object} event.detail - Detail object from moz-reorderable-list.evaluateKeyDownEvent or drag-and-drop event.
   * @param {Element} event.detail.draggedElement - The element being reordered.
   * @param {Element} event.detail.targetElement - The target element to reorder relative to.
   * @param {number} event.detail.position - Position relative to target (-1 for before, 0 for after).
   * @param {number} event.detail.draggedIndex - The index of the element being reordered.
   * @param {number} event.detail.targetIndex - The new index of the draggedElement.
   */
  handleReorder(event) {
    let { targetIndex } = event.detail;

    this.dispatchEvent(
      new CustomEvent("reorder", {
        bubbles: true,
        detail: event.detail,
      })
    );

    /**
     * Without requesting an animation frame, we will lose focus within
     * the box group when using Ctrl + Shift + ArrowDown. The focus will
     * move to the browser chrome which is unexpected.
     *
     */
    requestAnimationFrame(() => {
      this.listItems[targetIndex]?.focus();
    });
  }

  handleKeydown(event) {
    if (
      this.type == GROUP_TYPES.reorderable &&
      event.originalTarget == event.target.handleEl
    ) {
      let detail = this.reorderableList.evaluateKeyDownEvent(event);
      if (detail) {
        event.stopPropagation();
        this.handleReorder({ detail });
        return;
      }
    }

    let positionElement = event.target.closest("[position]");
    if (!positionElement) {
      // If the user has clicked on the MozBoxGroup it may get keydown events
      // even if there is no focused element within it. Then the event target
      // will be the <ul> and we won't find an element with [position].
      return;
    }
    let positionAttr = positionElement.getAttribute("position");
    let currentPosition = parseInt(positionAttr);

    switch (event.key) {
      case "Down":
      case "ArrowDown": {
        event.preventDefault();
        let nextItem = this.listItems[currentPosition + 1];
        nextItem?.focus(event);
        break;
      }
      case "Up":
      case "ArrowUp": {
        event.preventDefault();
        let prevItem = this.listItems[currentPosition - 1];
        prevItem?.focus(event);
        break;
      }
    }
  }

  handleFocus() {
    if (this.#tabbable) {
      this.#tabbable = false;
      this.listItems.forEach(item => {
        item.setAttribute("tabindex", "-1");
      });
    }
  }

  handleBlur() {
    if (!this.#tabbable) {
      this.#tabbable = true;
      this.listItems.forEach(item => {
        item.removeAttribute("tabindex");
      });
    }
  }

  updateItems() {
    this.listItems = [...this.children].filter(
      child =>
        child.slot !== "header" && child.slot !== "footer" && !child.hidden
    );
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://global/content/elements/moz-box-group.css"
      />
      <slot name="header"></slot>
      ${this.contentTemplate()}
      <slot name="footer"></slot>
    `;
  }

  updated(changedProperties) {
    let headerNode = this.headerSlot.assignedNodes()[0];
    let footerNode = this.footerSlot.assignedNodes().at(-1);
    headerNode?.classList.add("first");
    footerNode?.classList.add("last");

    if (changedProperties.has("listItems") && this.listItems.length) {
      this.listItems.forEach((item, i) => {
        if (
          this.type == GROUP_TYPES.list ||
          this.type == GROUP_TYPES.reorderable
        ) {
          item.slot = i;
          item.setAttribute("position", i);
        }
        item.classList.toggle("first", i == 0 && !headerNode);
        item.classList.toggle(
          "last",
          i == this.listItems.length - 1 && !footerNode
        );
        item.removeAttribute("tabindex");
      });
      if (!this.#tabbable) {
        this.#tabbable = true;
      }
    }

    if (
      changedProperties.has("type") &&
      (this.type == GROUP_TYPES.list || this.type == GROUP_TYPES.reorderable)
    ) {
      this.updateItems();
    }
  }
}
customElements.define("moz-box-group", MozBoxGroup);
