/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { html } from "chrome://global/content/vendor/lit.all.mjs";

const { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);

const MAX_PREVIEW_LINKS = 3;
const lazy = {};

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "CONTENT_SHARING_SERVER_URL",
  "browser.contentsharing.server.url",
  ""
);

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "CONTENT_SHARING_DEBUG",
  "browser.contentsharing.debug",
  false
);

const DEFAULT_COPY_ICON = "chrome://global/skin/icons/edit-copy.svg";
const DEFAULT_COPY_L10N_ID = "content-sharing-modal-copy-link";

const COPIED_COPY_ICON = "chrome://global/skin/icons/check.svg";
const COPIED_COPY_L10N_ID = "content-sharing-modal-link-copied";

// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-card.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";

/**
 * Element used for content sharing modal content
 */
export class ContentSharingModal extends MozLitElement {
  static properties = {
    share: { type: Object },
    error: { type: String },
    isSignedIn: { type: Boolean },
  };

  static queries = {
    title: ".share-title",
    linkCount: ".share-count",
    links: { all: ".link" },
    moreLinks: ".more-links",
    previewCard: ".preview > moz-card",
    copyButton: "#copy-button",
    viewPageButton: "#view-page",
    signInButton: "#sign-in",
  };

  async getUpdateComplete() {
    await super.getUpdateComplete();
    await this.previewCard.updateComplete;
  }

  connectedCallback() {
    super.connectedCallback();

    const shareObject = window.arguments?.[0];
    this.share = shareObject.share;
    this.error = shareObject.error;
    this.url = shareObject.url;
    this.isSignedIn = shareObject.isSignedIn;
  }

  close() {
    window.close();
  }

  linkTemplate(link) {
    if (link.type === "bookmarks") {
      return html`<div class="link">
        <img class="link-icon" src="chrome://global/skin/icons/folder.svg" />
        <span class="link-title">${link.title}</span>
      </div>`;
    }

    return html`<div class="link">
      <img class="link-icon" src="page-icon:${link.url}" />
      <span class="link-title">${link.title}</span>
    </div>`;
  }

  linksTemplate() {
    if (!this.share?.links) {
      return null;
    }

    if (this.share.links.length > MAX_PREVIEW_LINKS) {
      return html`${this.share.links
          .slice(0, 3)
          .map(link => this.linkTemplate(link))}
        <div
          class="more-links"
          data-l10n-id="content-sharing-modal-more-tabs"
          data-l10n-args=${JSON.stringify({
            count: this.share.links.length - MAX_PREVIEW_LINKS,
          })}
        ></div>`;
    }

    return this.share.links.map(link => this.linkTemplate(link));
  }

  handleViewPageClick() {
    this.close();
    this.documentGlobal.frameElement.documentGlobal.openWebLinkIn(
      this.url,
      "tab"
    );
  }

  handleCopyClick() {
    window.navigator.clipboard.writeText(this.url);

    this.copyButton.setAttribute("iconsrc", COPIED_COPY_ICON);
    this.copyButton.setAttribute("data-l10n-id", COPIED_COPY_L10N_ID);

    new Promise(r => setTimeout(r, 1000)).then(() => {
      this.copyButton.setAttribute("iconsrc", DEFAULT_COPY_ICON);
      this.copyButton.setAttribute("data-l10n-id", DEFAULT_COPY_L10N_ID);
    });
  }

  handleSignInClick() {
    const accountSlug = lazy.CONTENT_SHARING_DEBUG
      ? "/accounts/dummy/login/"
      : "/accounts/fxa/login/";
    const signInURL = lazy.CONTENT_SHARING_SERVER_URL + accountSlug;
    this.close();
    this.documentGlobal.frameElement.documentGlobal.openWebLinkIn(
      signInURL,
      "tab"
    );
  }

  buttonsTemplate() {
    if (this.isSignedIn) {
      return html`<moz-button
          @click=${this.handleViewPageClick}
          id="view-page"
          data-l10n-id="content-sharing-modal-view-page"
        ></moz-button
        ><moz-button
          id="copy-button"
          iconsrc=${DEFAULT_COPY_ICON}
          data-l10n-id=${DEFAULT_COPY_L10N_ID}
          type="primary"
          @click=${this.handleCopyClick}
        ></moz-button>`;
    }

    return html`<moz-button
      @click=${this.handleSignInClick}
      id="sign-in"
      data-l10n-id="content-sharing-modal-sign-in"
      type="primary"
    ></moz-button>`;
  }

  render() {
    if (!this.share) {
      return null;
    }

    return html`<link
        rel="stylesheet"
        href="chrome://browser/content/contentsharing/content-sharing-modal.css"
      />
      <link
        rel="stylesheet"
        href="chrome://global/skin/in-content/common.css"
      />
      <div id="backgroud-image"></div>
      <div id="plain-backgroud"></div>
      <div class="container">
        <div class="preview">
          <moz-card
            ><label class="share-header"
              ><span class="share-title">${this.share.title}</span>
              <span class="share-count"
                ><img
                  class="share-icon"
                  src="chrome://browser/content/contentsharing/content-sharing-icon.svg"
                />
                ${this.share.links.length}</span
              ></label
            >
            <div class="link-preview-list">${this.linksTemplate()}</div>
          </moz-card>
        </div>
        <div class="description">
          <moz-button
            @click=${this.close}
            type="ghost"
            id="close-button"
            iconsrc="chrome://global/skin/icons/close.svg"
          ></moz-button>

          <div class="description-content">
            <div>
              <h2 data-l10n-id="content-sharing-modal-title"></h2>
              <p data-l10n-id="content-sharing-modal-description"></p>
            </div>
            <moz-button-group>${this.buttonsTemplate()}</moz-button-group>
          </div>

          <div class="empty"></div>
        </div>
      </div>`;
  }
}
customElements.define("content-sharing-modal", ContentSharingModal);
