/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/website-chip-container.mjs";

/**
 * Renders the result of a natural language action performed by the assistant
 * (e.g. "Closed tabs"). Shows the action label, summary, and an undo button
 * when available. Clicking the header toggles the expanded state, which
 * reveals a list of stacked rows, each with its own label and optional
 * affected items (website chips).
 *
 * Dispatches a CustomEvent named action-result-undo when the user clicks undo.
 * The parent is responsible for performing the actual reversal and updating
 * the action state.
 *
 * @attribute {string} label - Header label (e.g. "Closed tab", "Closed 3 tabs")
 * @attribute {string} summary - Descriptive text for the action
 * @attribute {boolean} canUndo - Whether the undo button should be shown
 * @attribute {boolean} isExpanded - Whether the detail section is visible
 * @property {Array} rows - List of stacked dot rows each shaped:
 *  { label: string, items: Array<{ url: string, label: string }> }
 */
export class AIActionResult extends MozLitElement {
  static properties = {
    label: { type: String },
    rows: { type: Array },
    summary: { type: String },
    canUndo: { type: Boolean, attribute: "can-undo", reflect: true },
    isExpanded: { type: Boolean, attribute: "is-expanded", reflect: true },
  };

  constructor() {
    super();
    this.label = "";
    this.rows = [];
    this.summary = "";
    this.canUndo = false;
    this.isExpanded = false;
  }

  #handleUndo() {
    this.dispatchEvent(
      new CustomEvent("action-result-undo", { bubbles: true, composed: true })
    );
  }

  #handleToggle() {
    this.isExpanded = !this.isExpanded;
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/ai-action-result.css"
      />
      <div class="action-result-wrapper">
        <button
          type="button"
          class="action-result-header"
          aria-expanded=${this.isExpanded}
          @click=${this.#handleToggle}
        >
          <span class="action-result-indicator" aria-hidden="true"></span>
          <span class="action-result-label">${this.label}</span>
        </button>
        ${this.isExpanded
          ? html`
              <div class="action-result-expanded">
                ${this.rows.map(
                  row => html`
                    <div class="action-result-expanded-row">
                      <div class="action-result-expanded-row-header">
                        <span
                          class="action-result-dot"
                          aria-hidden="true"
                        ></span>
                        <span class="action-result-expanded-row-label">
                          ${row.label}
                        </span>
                      </div>
                      ${row.items?.length
                        ? html`
                            <website-chip-container
                              class="action-result-chips"
                              .websites=${row.items}
                            ></website-chip-container>
                          `
                        : nothing}
                    </div>
                  `
                )}
              </div>
            `
          : nothing}
        ${this.summary
          ? html`<p class="action-result-summary">${this.summary}</p>`
          : nothing}
        ${this.canUndo
          ? html`
              <moz-button
                class="action-result-undo"
                @click=${this.#handleUndo}
                data-l10n-id="smartwindow-nl-undo-button"
              ></moz-button>
            `
          : nothing}
      </div>
    `;
  }
}

customElements.define("ai-action-result", AIActionResult);
