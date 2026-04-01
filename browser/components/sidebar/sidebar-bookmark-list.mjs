/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, ifDefined } from "chrome://global/content/vendor/lit.all.mjs";

import {
  SidebarTabList,
  SidebarTabRow,
} from "chrome://browser/content/sidebar/sidebar-tab-list.mjs";

export class SidebarBookmarkList extends SidebarTabList {
  static properties = {
    ...SidebarTabList.properties,
    expandedFolderGuids: { type: Object },
  };

  constructor() {
    super();
    this.bookmarksContext = true;
    this.expandedFolderGuids = new Set();
    this.getItemHeight = (item, h) => this.#itemHeightGetter(item, h);
  }

  willUpdate(changes) {
    super.willUpdate(changes);
    if (changes.has("expandedFolderGuids")) {
      // Reassign to a new function reference so Lit detects the change and
      // propagates it to sublists, causing them to reset their cached heights.
      this.getItemHeight = (item, h) => this.#itemHeightGetter(item, h);
    }
  }

  #itemHeightGetter = (item, defaultHeight) => {
    if (!item.children || !this.expandedFolderGuids.has(item.guid)) {
      return defaultHeight;
    }
    return item.children.reduce(
      (sum, child) => sum + this.#itemHeightGetter(child, defaultHeight),
      defaultHeight
    );
  };

  static queries = {
    ...SidebarTabList.queries,
    rowEls: { all: "sidebar-bookmark-row" },
    folderEls: { all: "details" },
    folderLabelEl: ".bookmark-folder-label",
  };

  itemTemplate = (tabItem, i) => {
    let tabIndex = -1;
    if ((this.searchQuery || this.sortOption == "lastvisited") && i == 0) {
      tabIndex = 0;
    } else if (!this.searchQuery) {
      tabIndex = 0;
    }
    if (!tabItem.url && !tabItem.children) {
      return html`<div
        class="bookmark-separator"
        role="separator"
        tabindex="0"
        .guid=${tabItem.guid}
      ></div>`;
    }
    if (tabItem.children !== undefined) {
      if (!tabItem.children.length) {
        return html`<div class="bookmark-folder-label" .guid=${tabItem.guid}>
          ${tabItem.title}
        </div>`;
      }
      return html`
        <details
          ?open=${this.expandedFolderGuids.has(tabItem.guid)}
          @toggle=${e => this.#onFolderToggle(e, tabItem.guid)}
          .guid=${tabItem.guid}
        >
          <summary part="summary">${tabItem.title}</summary>
          <div id="content">
            <sidebar-bookmark-list
              maxTabsLength="-1"
              secondaryActionClass="delete-button"
              .tabItems=${tabItem.children}
              .expandedFolderGuids=${this.expandedFolderGuids}
              @fxview-tab-list-primary-action=${this.onPrimaryAction}
              @fxview-tab-list-secondary-action=${this.onSecondaryAction}
            >
            </sidebar-bookmark-list>
          </div>
        </details>
      `;
    }
    return html`
      <sidebar-bookmark-row
        ?active=${i == this.activeIndex}
        .canClose=${ifDefined(tabItem.canClose)}
        .closedId=${ifDefined(tabItem.closedId)}
        compact
        .currentActiveElementId=${this.currentActiveElementId}
        .closeRequested=${tabItem.closeRequested}
        .favicon=${tabItem.icon}
        .guid=${ifDefined(tabItem.guid)}
        .hasPopup=${this.hasPopup}
        .indicators=${tabItem.indicators}
        .primaryL10nArgs=${ifDefined(tabItem.primaryL10nArgs)}
        .primaryL10nId=${tabItem.primaryL10nId}
        role="listitem"
        .searchQuery=${ifDefined(this.searchQuery)}
        .secondaryActionClass=${ifDefined(
          this.secondaryActionClass ?? tabItem.secondaryActionClass
        )}
        .secondaryL10nArgs=${ifDefined(tabItem.secondaryL10nArgs)}
        .secondaryL10nId=${tabItem.secondaryL10nId}
        .selected=${this.selectedGuids.has(tabItem.guid)}
        .tabElement=${ifDefined(tabItem.tabElement)}
        tabindex=${tabIndex}
        .title=${tabItem.title}
        .url=${tabItem.url}
        @keydown=${e => e.currentTarget.primaryActionHandler(e)}
      ></sidebar-bookmark-row>
    `;
  };

  stylesheets() {
    return [
      super.stylesheets(),
      html`<link
        rel="stylesheet"
        href="chrome://browser/content/sidebar/sidebar-bookmark-list.css"
      />`,
    ];
  }

  #onFolderToggle(e, guid) {
    this.dispatchEvent(
      new CustomEvent("bookmark-folder-toggle", {
        bubbles: true,
        composed: true,
        detail: { guid, open: e.target.open },
      })
    );
  }
}
customElements.define("sidebar-bookmark-list", SidebarBookmarkList);

export class SidebarBookmarkRow extends SidebarTabRow {
  get tooltipText() {
    return this.url ? `${this.title}\n${this.url}` : null;
  }
}
customElements.define("sidebar-bookmark-row", SidebarBookmarkRow);
