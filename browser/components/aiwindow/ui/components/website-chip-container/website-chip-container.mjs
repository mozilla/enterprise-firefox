/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { html } from "chrome://global/content/vendor/lit.all.mjs";

/**
 * Container for rendering a horizontally scrollable row of website chips
 */
export class WebsiteChipContainer extends MozLitElement {
  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/website-chip-container.css"
      />
      <div class="chip-container">
        <div class="scroller" role="list">
          <slot></slot>
        </div>
      </div>
    `;
  }
}

customElements.define("website-chip-container", WebsiteChipContainer);
