/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  html,
  repeat,
  styleMap,
  when,
} from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/panel-list.js";

/**
 * TODO: This component is a starting point for a panel list for the AI Window.
 * Right now it is only used for the Smartbar mention suggestions, but it will
 * be used in more places in the future. Building this component out is covered
 * under Bug 2008983.
 *
 * A panel list which shows a list of filterable items.
 *
 * The component is based on `panel-item` and extended to support filtering.
 *
 * @typedef {{id: string, label: string, icon?: string}} ListItem
 * @typedef {{items: ListItem[], headerL10nId?: string}} ItemGroup
 * @property {ItemGroup[]} groups - Grouped list items
 * @property {string} placeholderL10nId - Fluent ID for empty state
 */
export class SuggestionsPanelList extends MozLitElement {
  static shadowRootOptions = {
    ...MozLitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static properties = {
    groups: { type: Array },
    anchor: { type: Object },
    placeholderL10nId: { type: String },
  };

  #panelList = null;
  #anchorElement = null;

  constructor() {
    super();
    this.groups = [];
    this.anchor = null;
    this.placeholderL10nId = "";
  }

  firstUpdated() {
    this.#panelList = this.shadowRoot.querySelector("panel-list");
  }

  updated(changedProperties) {
    super.updated(changedProperties);
    if (changedProperties.has("anchor")) {
      // If anchor is an element use it directly,
      // otherwise we can use the positioned span.
      this.#anchorElement =
        this.anchor instanceof Element
          ? this.anchor
          : this.renderRoot.querySelector(".suggestions-panel-list-anchor");
    }
  }

  async show() {
    await this.updateComplete;
    this.#panelList.show(null, this.#anchorElement);
  }

  async hide() {
    await this.updateComplete;
    this.#panelList.hide();
  }

  async toggle() {
    await this.updateComplete;
    this.#panelList.toggle(null, this.#anchorElement);
  }

  handlePanelClick(e) {
    const panelItem = e.target.closest("panel-item");
    if (panelItem && !panelItem.classList.contains("panel-section-header")) {
      this.dispatchEvent(
        new CustomEvent("item-selected", {
          detail: {
            id: panelItem.itemId,
            label: panelItem.itemLabel,
            icon: panelItem.itemIcon,
          },
          bubbles: true,
          composed: true,
        })
      );
      this.hide();
    }
  }

  render() {
    const isEmpty =
      !this.groups.length || this.groups.every(group => !group.items.length);
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/suggestions-panel-list.css"
      />
      ${when(
        this.anchor && !(this.anchor instanceof Element),
        () =>
          html`<span
            class="suggestions-panel-list-anchor"
            style=${styleMap({
              "--anchor-left": `${this.anchor.left - this.getBoundingClientRect().left}px`,
              "--anchor-top": `${this.anchor.top - this.getBoundingClientRect().top}px`,
              "--anchor-width": `${this.anchor.width}px`,
              "--anchor-height": `${this.anchor.height}px`,
            })}
          ></span>`
      )}
      <panel-list
        @click=${this.handlePanelClick}
        @keydown=${this.handleKeyDown}
      >
        ${when(
          isEmpty,
          () =>
            html`<panel-item
              disabled
              role="presentation"
              class="panel-section-header"
              data-l10n-id=${this.placeholderL10nId}
            ></panel-item>`,
          () =>
            repeat(
              this.groups,
              group => group.headerL10nId || "",
              group =>
                when(
                  group.items.length,
                  () => html`
                    ${when(
                      group.headerL10nId,
                      () =>
                        html`<panel-item
                          disabled
                          role="presentation"
                          class="panel-section-header"
                          data-l10n-id=${group.headerL10nId}
                        ></panel-item>`
                    )}
                    ${repeat(
                      group.items,
                      item => item.id,
                      item =>
                        html`<panel-item
                          .itemId=${item.id}
                          .itemLabel=${item.label}
                        >
                          ${item.label}
                        </panel-item>`
                    )}
                  `
                )
            )
        )}
      </panel-list>
    `;
  }
}

customElements.define("suggestions-panel-list", SuggestionsPanelList);
