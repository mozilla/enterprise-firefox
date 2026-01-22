/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { html, ifDefined } from "chrome://global/content/vendor/lit.all.mjs";
import {
  LINKS,
  ERRORS,
} from "chrome://browser/content/ipprotection/ipprotection-constants.mjs";

// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/ipprotection/ipprotection-message-bar.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/ipprotection/ipprotection-signedout.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/ipprotection/ipprotection-status-card.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/ipprotection/ipprotection-status-box.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-toggle.mjs";

/**
 * Custom element that implements a message bar and status card for IP protection.
 */
export default class IPProtectionContentElement extends MozLitElement {
  static queries = {
    signedOutEl: "ipprotection-signedout",
    messagebarEl: "ipprotection-message-bar",
    statusCardEl: "ipprotection-status-card",
    upgradeEl: "#upgrade-vpn-content",
    activeSubscriptionEl: "#active-subscription-vpn-content",
    supportLinkEl: "#vpn-support-link",
    statusBoxEl: "ipprotection-status-box",
    siteExclusionControlEl: "#site-exclusion-control",
    siteExclusionToggleEl: "#site-exclusion-toggle",
  };

  static properties = {
    state: { type: Object, attribute: false },
    _showMessageBar: { type: Boolean, state: true },
    _messageDismissed: { type: Boolean, state: true },
    // Track toggle state separately so that we can tell when the toggle
    // is enabled because of the existing protection state or because of user action.
    _toggleEnabled: { type: Boolean, state: true },
  };

  constructor() {
    super();

    this.state = {};

    this.keyListener = this.#keyListener.bind(this);
    this.messageBarListener = this.#messageBarListener.bind(this);
    this.statusCardListener = this.#statusCardListener.bind(this);
    this._showMessageBar = false;
    this._messageDismissed = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.dispatchEvent(new CustomEvent("IPProtection:Init", { bubbles: true }));
    this.addEventListener("keydown", this.keyListener, { capture: true });
    this.addEventListener(
      "ipprotection-status-card:user-toggled-on",
      this.#statusCardListener
    );
    this.addEventListener(
      "ipprotection-status-card:user-toggled-off",
      this.#statusCardListener
    );
    this.addEventListener(
      "ipprotection-message-bar:user-dismissed",
      this.#messageBarListener
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    this.removeEventListener("keydown", this.keyListener, { capture: true });
    this.removeEventListener(
      "ipprotection-status-card:user-toggled-on",
      this.#statusCardListener
    );
    this.removeEventListener(
      "ipprotection-status-card:user-toggled-off",
      this.#statusCardListener
    );
    this.removeEventListener(
      "ipprotection-message-bar:user-dismissed",
      this.#messageBarListener
    );
  }

  get canEnableConnection() {
    return this.state && this.state.isProtectionEnabled && !this.state.error;
  }

  get #hasErrors() {
    return !this.state || !!this.state.error;
  }

  handleClickSupportLink(event) {
    const win = event.target.ownerGlobal;

    if (event.target === this.supportLinkEl) {
      event.preventDefault();
      win.openWebLinkIn(LINKS.PRODUCT_URL, "tab");
      this.dispatchEvent(
        new CustomEvent("IPProtection:Close", { bubbles: true })
      );
    }
  }

  handleUpgrade(event) {
    const win = event.target.ownerGlobal;
    win.openWebLinkIn(LINKS.PRODUCT_URL + "#pricing", "tab");
    // Close the panel
    this.dispatchEvent(
      new CustomEvent("IPProtection:ClickUpgrade", { bubbles: true })
    );

    Glean.ipprotection.clickUpgradeButton.record();
  }

  focus() {
    if (this.state.isSignedOut) {
      this.signedOutEl?.focus();
    } else {
      this.statusCardEl?.focus();
    }
  }

  #keyListener(event) {
    let keyCode = event.code;
    switch (keyCode) {
      case "Tab":
      case "ArrowUp":
      // Intentional fall-through
      case "ArrowDown": {
        event.stopPropagation();
        event.preventDefault();

        let isForward =
          (keyCode == "Tab" && !event.shiftKey) || keyCode == "ArrowDown";
        let direction = isForward
          ? Services.focus.MOVEFOCUS_FORWARD
          : Services.focus.MOVEFOCUS_BACKWARD;
        Services.focus.moveFocus(
          window,
          null,
          direction,
          Services.focus.FLAG_BYKEY
        );
        break;
      }
    }
  }

  #statusCardListener(event) {
    if (event.type === "ipprotection-status-card:user-toggled-on") {
      this.dispatchEvent(
        new CustomEvent("IPProtection:UserEnable", { bubbles: true })
      );
    } else if (event.type === "ipprotection-status-card:user-toggled-off") {
      this.dispatchEvent(
        new CustomEvent("IPProtection:UserDisable", { bubbles: true })
      );
    }
  }

  #messageBarListener(event) {
    if (event.type === "ipprotection-message-bar:user-dismissed") {
      this._showMessageBar = false;
      this._messageDismissed = true;
      this.state.error = "";
      this.state.bandwidthWarning = false;
    }
  }

  handleToggleUseVPN(event) {
    let isEnabled = event.target.pressed;

    if (isEnabled) {
      this.dispatchEvent(
        new CustomEvent("IPProtection:UserEnableVPNForSite", {
          bubbles: true,
        })
      );
    } else {
      this.dispatchEvent(
        new CustomEvent("IPProtection:UserDisableVPNForSite", {
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  updated(changedProperties) {
    super.updated(changedProperties);

    // Clear messages when there is an error.
    if (this.state.error) {
      this._messageDismissed = false;
    }
  }

  messageBarTemplate() {
    let messageId;
    let messageLink;
    let messageLinkl10nId;
    let messageType = "info";
    // If there are errors, the error message should take precedence
    if (this.#hasErrors) {
      messageId = "ipprotection-message-generic-error";
      messageType = ERRORS.GENERIC;
    } else if (this.state.bandwidthWarning) {
      messageId = "ipprotection-message-bandwidth-warning";
      messageType = "warning";
    } else if (this.state.onboardingMessage) {
      messageId = this.state.onboardingMessage;
      messageType = "info";

      switch (this.state.onboardingMessage) {
        case "ipprotection-message-continuous-onboarding-intro":
          break;
        case "ipprotection-message-continuous-onboarding-autostart":
          messageLink = "about:settings#privacy";
          messageLinkl10nId = "setting-link";
          break;
        case "ipprotection-message-continuous-onboarding-site-settings":
          messageLink = "about:settings#privacy";
          messageLinkl10nId = "setting-link";
          break;
      }
    }

    return html`
      <ipprotection-message-bar
        class="vpn-top-content"
        type=${messageType}
        .messageId=${ifDefined(messageId)}
        .messageLink=${ifDefined(messageLink)}
        .messageLinkl10nId=${ifDefined(messageLinkl10nId)}
      ></ipprotection-message-bar>
    `;
  }

  statusCardTemplate() {
    return html`
      <ipprotection-status-card
        .protectionEnabled=${this.canEnableConnection}
        .location=${this.state.location}
      ></ipprotection-status-card>
    `;
  }

  pausedTemplate() {
    return html`
      <ipprotection-status-box
        headerL10nId="ipprotection-connection-status-paused-title"
        descriptionL10nId="ipprotection-connection-status-paused-description"
        type="disconnected"
      >
        <div slot="content">
          <link
            rel="stylesheet"
            href="chrome://browser/content/ipprotection/ipprotection-content.css"
          />
          <div id="upgrade-vpn-content">
            <h2 id="upgrade-vpn-title" data-l10n-id="upgrade-vpn-title"></h2>
            <span
              id="upgrade-vpn-description"
              data-l10n-id="upgrade-vpn-description"
              class="text-deemphasized"
            ></span>
            <moz-button
              id="upgrade-vpn-button"
              type="primary"
              data-l10n-id="upgrade-vpn-button"
              @click=${this.handleUpgrade}
            ></moz-button>
          </div>
        </div>
      </ipprotection-status-box>
    `;
  }

  exclusionToggleTemplate() {
    if (
      !this.state.siteData ||
      !this.state.isProtectionEnabled ||
      this.#hasErrors
    ) {
      return null;
    }

    const isExclusion = this.state.siteData.isExclusion;
    const siteExclusionToggleStateL10nId = isExclusion
      ? "site-exclusion-toggle-disabled"
      : "site-exclusion-toggle-enabled";
    return html` <div id="site-exclusion-control">
      <span id="site-exclusion-label-container">
        <img
          id="site-exclusion-icon"
          src="chrome://browser/content/ipprotection/assets/shield-vpn-exceptions.svg"
        />
        <label
          data-l10n-id="site-exclusion-toggle-label"
          id="site-exclusion-label"
          for="site-exclusion-toggle"
        ></label>
      </span>
      <moz-toggle
        data-l10n-id=${siteExclusionToggleStateL10nId}
        data-l10n-attrs="label"
        id="site-exclusion-toggle"
        ?pressed=${!isExclusion}
        @toggle=${this.handleToggleUseVPN}
      >
      </moz-toggle>
    </div>`;
  }

  mainContentTemplate() {
    // TODO: Update support-page with new SUMO link for Mozilla VPN - Bug 1975474
    if (this.state.isSignedOut) {
      return html` <ipprotection-signedout></ipprotection-signedout> `;
    }

    if (this.state.paused) {
      return html` ${this.pausedTemplate()} `;
    }

    return html`
      ${this.statusCardTemplate()} ${this.exclusionToggleTemplate()}
    `;
  }

  render() {
    if (
      (this.#hasErrors ||
        this.state.onboardingMessage ||
        this.state.bandwidthWarning) &&
      !this._messageDismissed
    ) {
      this._showMessageBar = true;
    }

    const messageBar = this._showMessageBar ? this.messageBarTemplate() : null;

    let content = html`${messageBar}${this.mainContentTemplate()}`;

    // TODO: Conditionally render post-upgrade subview within #ipprotection-content-wrapper - Bug 1973813
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/ipprotection/ipprotection-content.css"
      />
      <div id="ipprotection-content-wrapper">${content}</div>
    `;
  }
}

customElements.define("ipprotection-content", IPProtectionContentElement);
