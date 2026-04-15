/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";

/**
 * Numeric error codes received from the back-end via error.error.
 * These are the only reliable identifiers as the HTTP status codes
 * do not propagate to the front-end.
 */
const ERROR_CODES = {
  BUDGET_EXCEEDED: 1,
  RATE_LIMIT_EXCEEDED: 2,
  CHAT_MAX_LENGTH: 3,
  ACCOUNT_ERROR: 4,
};

/**
 * Shows an error message based on an error code
 */
export class ChatAssistantError extends MozLitElement {
  /**
   * @typedef {object} ErrorObject
   * @property {number|string} [error] - Error subcode - number for 429, string for others
   */
  static properties = {
    error: { type: Object },
    actionButton: { type: Object },
    errorText: { type: Object },
  };

  constructor() {
    super();
    this.setGenericError();
  }

  willUpdate(changed) {
    if (changed.has("error")) {
      this.getErrorInformation();
    }
  }

  openNewChat() {
    const event = new CustomEvent("aiChatError:new-chat", {
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  openAccountSignIn() {
    const event = new CustomEvent("aiChatError:sign-in", {
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  retryAssistantMessage() {
    const event = new CustomEvent("aiChatError:retry-message", {
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  setGenericError() {
    this.errorText = {
      header: "smartwindow-assistant-error-generic-header",
    };
    this.actionButton = {
      label: "smartwindow-retry-btn",
      action: this.retryAssistantMessage.bind(this),
    };
  }

  getErrorInformation() {
    if (!this.error) {
      return;
    }

    switch (this.error.error) {
      case ERROR_CODES.CHAT_MAX_LENGTH:
        this.errorText = {
          header: "smartwindow-assistant-error-max-length-header",
        };
        this.actionButton = {
          label: "smartwindow-clear-btn",
          action: this.openNewChat.bind(this),
        };
        break;

      case ERROR_CODES.RATE_LIMIT_EXCEEDED:
        this.errorText = {
          header: "smartwindow-assistant-error-many-requests-header",
        };
        this.actionButton = null;
        break;

      case ERROR_CODES.BUDGET_EXCEEDED:
        this.errorText = {
          header: "smartwindow-assistant-error-budget-header",
          body: "smartwindow-assistant-error-budget-body",
        };
        this.actionButton = null;
        break;

      case ERROR_CODES.ACCOUNT_ERROR:
        this.errorText = {
          header: "smartwindow-assistant-error-account-header",
        };
        this.actionButton = {
          label: "smartwindow-signin-btn",
          action: this.openAccountSignIn.bind(this),
        };
        break;

      default:
        this.setGenericError();
        break;
    }
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/chat-assistant-error.css"
      />
      <div class="chat-assistant-error">
        <h3
          class="chat-assistant-error__header"
          data-l10n-id=${this.errorText?.header}
        ></h3>
        ${this.errorText?.body
          ? html`<p
              class="chat-assistant-error__body"
              data-l10n-id=${this.errorText?.body}
            ></p>`
          : nothing}
        ${this.actionButton
          ? html`<moz-button
              class="chat-assistant-error__button"
              data-l10n-id=${this.actionButton?.label}
              size="small"
              @click=${this.actionButton?.action}
            ></moz-button>`
          : nothing}
      </div>
    `;
  }
}

customElements.define("chat-assistant-error", ChatAssistantError);
