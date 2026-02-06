/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { LINKS } from "chrome://browser/content/ipprotection/ipprotection-constants.mjs";

/**
 * Element used for displaying VPN bandwidth usage.
 * By default, the element will display a progress bar and numeric text of the
 * available bandwidth. Adding the attribute `numeric` will only display the
 * numeric text of available bandwidth.
 */
export default class BandwidthUsageCustomElement extends MozLitElement {
  static properties = {
    numeric: { type: Boolean, reflect: true },
    value: { type: Number },
    max: { type: Number },
  };

  get bandwidthPercent() {
    const percent = (100 * this.value) / this.max;
    if (percent > 90) {
      return 90;
    } else if (percent > 75) {
      return 75;
    }
    return percent.toFixed(0);
  }

  get bandwidthLeft() {
    return this.max - this.value;
  }

  get bandwidthUsageLeft() {
    if (this.value < 1) {
      // Bug 2006997 - Handle this scenario where less than 1 GB used.
      return Math.floor(this.bandwidthLeft);
    } else if (this.bandwidthLeft < 1) {
      // Show usage left in MB if less than 1GB left
      return this.bandwidthLeft.toFixed(0);
    }

    return this.bandwidthLeft.toFixed(0);
  }

  get bandwidthLeftDataL10nId() {
    if (this.bandwidthLeft < 1) {
      return "ip-protection-bandwidth-left-mb";
    }
    return "ip-protection-bandwidth-left-gb";
  }

  get bandwidthLeftThisMonthDataL10nId() {
    if (this.bandwidthLeft < 1) {
      return "ip-protection-bandwidth-left-this-month-mb";
    }
    return "ip-protection-bandwidth-left-this-month-gb";
  }

  constructor() {
    super();
    this.numeric = false;
  }

  progressBarTemplate() {
    if (this.numeric) {
      return null;
    }

    let descriptionText;
    if (this.value < this.max) {
      descriptionText = html`<span
        id="progress-description"
        data-l10n-id=${this.bandwidthLeftDataL10nId}
        data-l10n-args=${JSON.stringify({
          usageLeft: this.bandwidthUsageLeft,
          maxUsage: this.max,
        })}
      ></span>`;
    } else {
      descriptionText = html`<span
        id="progress-description"
        data-l10n-id="ip-protection-bandwidth-hit-for-the-month"
        data-l10n-args=${JSON.stringify({
          maxUsage: this.max,
        })}
      ></span>`;
    }

    return html`
      <div class="container">
        <h3
          id="bandwidth-header"
          data-l10n-id="ip-protection-bandwidth-header"
        ></h3>
        <div>
          <span
            id="usage-help-text"
            data-l10n-id="ip-protection-bandwidth-help-text"
            data-l10n-args=${JSON.stringify({
              maxUsage: this.max,
            })}
          ></span>
          <a
            is="moz-support-link"
            part="support-link"
            support-page=${LINKS.SUPPORT_URL}
          ></a>
        </div>
        <div id="progress-container">
          <progress
            id="progress-bar"
            max="150"
            value=${this.value}
            percent=${this.bandwidthPercent}
          ></progress>
          <div id="min-progress"></div>
        </div>

        ${descriptionText}
      </div>
    `;
  }

  numericTemplate() {
    if (!this.numeric) {
      return null;
    }

    if (this.value < this.max) {
      return html`<span
        id="progress-description"
        data-l10n-id=${this.bandwidthLeftThisMonthDataL10nId}
        data-l10n-args=${JSON.stringify({
          usageLeft: this.bandwidthUsageLeft,
          maxUsage: this.max,
        })}
      ></span>`;
    }

    return html`<span
      id="progress-description"
      data-l10n-id="ip-protection-bandwidth-hit-for-the-month"
      data-l10n-args=${JSON.stringify({
        maxUsage: this.max,
      })}
    ></span>`;
  }

  render() {
    let content = null;
    if (this.numeric) {
      content = this.numericTemplate();
    } else {
      content = this.progressBarTemplate();
    }

    return html`<link
        rel="stylesheet"
        href="chrome://browser/content/ipprotection/bandwidth-usage.css"
      />
      ${content}`;
  }
}
customElements.define("bandwidth-usage", BandwidthUsageCustomElement);
