/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "moz-src:///toolkit/components/enterprise/modules/EnterpriseCommon.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("SitePoliciesButton");
});

const BUTTON_ID = "lockdown-mode-button";
const PANEL_ID = "panelUI-lockdown-mode";
const DETAILS_FOOTER_ID = "lockdown-mode-details-footer";
const DETAILS_BUTTON_ID = "lockdown-mode-details-button";
const DETAILS_COUNT_ID = "lockdown-mode-details-count";
const DETAILS_PANEL_ID = "panelUI-lockdown-mode-details";
const DETAILS_LIST_ID = "lockdown-mode-details-list";

/**
 * The SitePolicies protections that can be listed in the details panel, in
 * display order.
 *
 * @type {Array<{policy: string, l10nId: string, isApplied: function(nsIURI, number): boolean}>}
 */
export const SITE_PROTECTIONS = [
  {
    policy: "HttpsOnly",
    l10nId: "lockdown-mode-protection-https-only",
    isApplied: uri => !Services.policies.isAllowedForURI("http", uri),
  },
  {
    policy: "DisableServiceWorkers",
    l10nId: "lockdown-mode-protection-disable-service-workers",
    isApplied: uri => !Services.policies.isAllowedForURI("serviceworkers", uri),
  },
  {
    policy: "Container",
    l10nId: "lockdown-mode-protection-container",
    // Tabs only move into the policy container for some navigations.
    isApplied: (uri, userContextId) => {
      const container = Services.policies.getContainerForURI(uri);
      return container != 0 && container == userContextId;
    },
  },
  {
    policy: "DisableJit",
    l10nId: "lockdown-mode-protection-disable-jit",
    isApplied: uri => !Services.policies.isAllowedForURI("jit", uri),
  },
];

/**
 * SitePoliciesButton manages the urlbar button and panels shown when
 * SitePolicies apply to the current page, for a single browser window.
 */
export class SitePoliciesButton {
  #window = null;
  #progressListener = null;
  #onClick = null;
  #onMainShowing = null;
  #onDetailsCommand = null;
  #onDetailsShowing = null;

  /**
   * @param {Window} window - The chrome window that owns the button.
   */
  constructor(window) {
    const { document } = window;
    const button = document.getElementById(BUTTON_ID);
    if (!button) {
      return;
    }

    this.#window = window;

    this.#onClick = event => {
      window.PanelUI.showSubView(PANEL_ID, button, event);
    };
    button.addEventListener("click", this.#onClick);

    this.#onMainShowing = event => this.#updateDetailsCount(event);
    this.#mainView.addEventListener("ViewShowing", this.#onMainShowing);

    this.#onDetailsCommand = event => {
      window.PanelUI.showSubView(DETAILS_PANEL_ID, event.target);
    };
    document
      .getElementById(DETAILS_BUTTON_ID)
      .addEventListener("command", this.#onDetailsCommand);

    this.#onDetailsShowing = event => this.#populateDetails(event);
    this.#detailsView.addEventListener("ViewShowing", this.#onDetailsShowing);

    this.#progressListener = {
      onLocationChange: (webProgress, _request, location) => {
        if (!webProgress.isTopLevel) {
          return;
        }
        this.#update(location);
      },
    };
    window.gBrowser.addProgressListener(this.#progressListener);
  }

  /**
   * The tabbrowser of the owning window.
   *
   * @returns {object}
   */
  get gBrowser() {
    return this.#window.gBrowser;
  }

  /**
   * The document of the owning window.
   *
   * @returns {Document}
   */
  get #document() {
    return this.#window.document;
  }

  /**
   * Resolves the urlbar button element on demand from the window.
   *
   * @returns {Element}
   */
  get #button() {
    return this.#document.getElementById(BUTTON_ID);
  }

  /**
   * The main lockdown mode panelview.
   *
   * @returns {Element|null}
   */
  get #mainView() {
    return this.#getViewNode(PANEL_ID);
  }

  /**
   * The panelview listing the protections applied to the current page.
   *
   * @returns {Element|null}
   */
  get #detailsView() {
    return this.#getViewNode(DETAILS_PANEL_ID);
  }

  /**
   * Looks up a panelview by ID, including views held in the panel view cache.
   *
   * @param {string} id
   * @returns {Element|null}
   */
  #getViewNode(id) {
    return this.#window.PanelMultiView.getViewNode(this.#document, id);
  }

  /**
   * Shows the button when at least one SitePolicies protection is applied to
   * the given URI.
   *
   * @param {nsIURI} uri
   */
  #update(uri) {
    this.#button.hidden = !SitePoliciesButton.getAppliedProtections(
      uri,
      this.#userContextId
    ).length;
  }

  /**
   * The container of the page shown in the selected tab.
   *
   * @returns {number}
   */
  get #userContextId() {
    return this.gBrowser.selectedBrowser.contentPrincipal.userContextId;
  }

  /**
   * Returns the protections that apply to a page.
   *
   * @param {nsIURI} uri - The page's URI.
   * @param {number} userContextId - The container the page is loaded in.
   * @returns {Array<{policy: string, l10nId: string}>}
   */
  static getAppliedProtections(uri, userContextId) {
    return SITE_PROTECTIONS.filter(protection => {
      try {
        return protection.isApplied(uri, userContextId);
      } catch (e) {
        lazy.log.warn(`Failed to check ${protection.policy} for URI: `, e);
        return false;
      }
    });
  }

  /**
   * Shows how many protections apply to the current page on the row that
   * opens the details panel, hiding the row when there are none.
   *
   * @param {CustomEvent} event - The ViewShowing event for the main panel.
   */
  #updateDetailsCount(event) {
    const mainView = this.#mainView;
    const count = SitePoliciesButton.getAppliedProtections(
      this.gBrowser.currentURI,
      this.#userContextId
    ).length;
    const countLabel = mainView.querySelector(`#${DETAILS_COUNT_ID}`);
    this.#document.l10n.setAttributes(
      countLabel,
      "lockdown-mode-details-count",
      { count }
    );
    mainView.querySelector(`#${DETAILS_FOOTER_ID}`).hidden = !count;
    event.detail.addBlocker(
      this.#document.l10n.translateElements([countLabel])
    );
  }

  /**
   * Fills the details panel with the protections applied to the current page.
   *
   * @param {CustomEvent} event - The ViewShowing event for the details panel.
   */
  #populateDetails(event) {
    const document = this.#document;
    const items = SitePoliciesButton.getAppliedProtections(
      this.gBrowser.currentURI,
      this.#userContextId
    ).map(({ policy, l10nId }) => {
      const item = document.createElement("div");
      item.className = "lockdown-mode-protection";
      const name = document.createElement("div");
      name.className = "lockdown-mode-protection-name";
      name.textContent = policy;
      const description = document.createElement("div");
      description.className = "lockdown-mode-protection-description";
      document.l10n.setAttributes(description, l10nId);
      item.append(name, description);
      return item;
    });
    const list = this.#detailsView.querySelector(`#${DETAILS_LIST_ID}`);
    list.replaceChildren(...items);
    // Wait for translation so the panel measures the final height.
    event.detail.addBlocker(document.l10n.translateFragment(list));
  }

  /**
   * Removes all listeners owned by this instance.
   */
  uninit() {
    if (!this.#window) {
      return;
    }
    this.#button.removeEventListener("click", this.#onClick);
    this.#mainView.removeEventListener("ViewShowing", this.#onMainShowing);
    this.#document
      .getElementById(DETAILS_BUTTON_ID)
      .removeEventListener("command", this.#onDetailsCommand);
    this.#detailsView.removeEventListener(
      "ViewShowing",
      this.#onDetailsShowing
    );
    this.gBrowser.removeProgressListener(this.#progressListener);
  }
}

/**
 * Per-window lifecycle entry point for the SitePolicies button.
 */
export const SitePoliciesButtonHandler = {
  /**
   * @param {Window} window chrome window
   */
  init(window) {
    if (Services.felt.isFeltUI()) {
      return;
    }
    const button = new SitePoliciesButton(window);
    window.addEventListener("unload", () => button.uninit(), { once: true });
  },
};
