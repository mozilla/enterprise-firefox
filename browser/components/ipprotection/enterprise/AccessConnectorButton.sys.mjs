/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  IPPPrincipalRules:
    "moz-src:///toolkit/components/ipprotection/IPPSiteRuleManager.sys.mjs",
  IPPSiteRuleManager:
    "moz-src:///toolkit/components/ipprotection/IPPSiteRuleManager.sys.mjs",
  IPPProxyManager:
    "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPProtectionService:
    "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
});

import { getSitePrincipal } from "chrome://browser/content/ipprotection/ipprotection-utils.mjs";

/**
 * AccessConnectorButton manages the enterprise Access Connector urlbar button
 * and its panel for a single browser window.
 */
export class AccessConnectorButton {
  #window = null;
  #progressListener = null;
  #onClick = null;
  #lastErrorDomain = null;

  static BUTTON_ID = "access-connector-button";
  static PANEL_ID = "panelUI-access-connector";
  static PANEL_HEADER_ID = "access-connector-panel-header";
  static PANEL_MESSAGE_ID = "access-connector-panel-message";

  static PROXY_ERROR_CODES = new Set([
    "proxyConnectFailure",
    "proxyResolveFailure",
  ]);

  /**
   * Gets the gBrowser from the weak reference to the window.
   *
   * @returns {object|undefined}
   *  The gBrowser object, or undefined if the window has been garbage collected.
   */
  get gBrowser() {
    const win = this.#window.get();
    return win?.gBrowser;
  }

  /**
   * Gets the urlbar button for this window.
   *
   * @returns {XULElement|null}
   *  The button element, or null if not available.
   */
  get button() {
    const win = this.#window.get();
    return (
      win?.document.getElementById(AccessConnectorButton.BUTTON_ID) ?? null
    );
  }

  /**
   * @param {Window} window
   *  The chrome window that owns the button.
   */
  constructor(window) {
    this.#window = Cu.getWeakReference(window);
    this.handleEvent = this.#handleEvent.bind(this);
    this.#onClick = event => {
      this.#window
        .get()
        ?.PanelUI.showSubView(
          AccessConnectorButton.PANEL_ID,
          this.button,
          event
        );
    };

    this.button?.addEventListener("click", this.#onClick);

    this.#addProgressListener();
    lazy.IPProtectionService.addEventListener(
      "IPProtectionService:StateChanged",
      this.handleEvent
    );
    lazy.IPPProxyManager.addEventListener(
      "IPPProxyManager:StateChanged",
      this.handleEvent
    );
    lazy.IPPProxyManager.addEventListener(
      "IPPProxyManager:ModeChanged",
      this.handleEvent
    );
    lazy.IPPSiteRuleManager.addEventListener(
      "SiteRuleManager:RuleChanged",
      this.handleEvent
    );

    if (this.gBrowser?.tabContainer) {
      this.gBrowser.tabContainer.addEventListener("TabSelect", this);
    }

    this.updateState();
  }

  /**
   * Creates and registers a progress listener for the window.
   */
  #addProgressListener() {
    if (!this.gBrowser) {
      return;
    }

    this.#progressListener = {
      onLocationChange: (
        aBrowser,
        aWebProgress,
        _aRequest,
        aLocationURI,
        _aFlags
      ) => {
        if (!aWebProgress.isTopLevel) {
          return;
        }

        if (aBrowser !== this.gBrowser?.selectedBrowser) {
          return;
        }

        if (!aLocationURI) {
          return;
        }

        this.updateState();
      },
    };

    this.gBrowser.addTabsProgressListener(this.#progressListener);
  }

  /**
   * Event handler for document-level events.
   *
   * @param {Event} event
   *  The event to handle.
   */
  #handleEvent(event) {
    if (
      event.type !== "IPProtectionService:StateChanged" &&
      event.type !== "IPPProxyManager:StateChanged" &&
      event.type !== "IPPProxyManager:ModeChanged" &&
      event.type !== "SiteRuleManager:RuleChanged" &&
      event.type !== "TabSelect"
    ) {
      return;
    }

    this.updateState();
  }

  /**
   * Updates the button and panel to reflect the current state.
   */
  updateState() {
    const win = this.#window.get();
    if (!win) {
      return;
    }

    const button = this.button;
    if (!button) {
      return;
    }

    let isProxyActive = !!lazy.IPPProxyManager.active;
    let proxyError = isProxyActive
      ? this.#getProxyError(this.gBrowser.selectedBrowser?.contentPrincipal)
      : null;

    // Policy-included sites are claimed by a higher-precedence provider, so
    // unlike the toolbar button this does not gate on canManage().
    let principal = getSitePrincipal(this.gBrowser);
    let browserId = this.gBrowser.selectedBrowser?.browserId;
    let isIncluded =
      isProxyActive &&
      !!principal &&
      lazy.IPPSiteRuleManager.getRule(principal, browserId) ===
        lazy.IPPPrincipalRules.INCLUDED;

    let isError = !!proxyError;

    this.updateIconStatus(button, {
      isProtected: isError || isIncluded,
      isError,
    });

    if (isError && proxyError.domain !== this.#lastErrorDomain) {
      this.#recordProxyError(proxyError.domain);
    }
    this.#lastErrorDomain = isError ? proxyError.domain : null;
  }

  /**
   * Checks whether the given principal is a neterror page for a proxy
   * failure.
   *
   * @param {?nsIPrincipal} principal
   *  The content principal of the selected browser.
   * @returns {{ domain: string }|null}
   *  The domain that failed to load, or null if this is not a proxy error.
   */
  #getProxyError(principal) {
    const principalURI = principal?.URI;
    if (!principalURI?.spec.startsWith("about:neterror")) {
      return null;
    }

    const params = new URLSearchParams(principalURI.query);
    if (!AccessConnectorButton.PROXY_ERROR_CODES.has(params.get("e"))) {
      return null;
    }

    let domain = "";
    try {
      domain = new URL(params.get("u") ?? "").hostname;
    } catch {}
    return { domain };
  }

  /**
   * Updates the button and panel to reflect the Access Connector status.
   *
   * @param {XULElement} button
   *  The button to update
   * @param {object} status
   *  Access Connector status. isProtected is true when the current site is
   *  routed through the proxy, isError when the proxy failed to load it.
   */
  updateIconStatus(button, status = { isProtected: false, isError: false }) {
    if (!button) {
      return;
    }

    let { isProtected, isError } = status;

    button.hidden = !isProtected;
    if (isError) {
      button.setAttribute("error", "true");
    } else {
      button.removeAttribute("error");
    }

    let doc = button.ownerDocument;
    doc.l10n.setAttributes(
      button,
      isError ? "access-connector-button-error" : "access-connector-button"
    );

    let panelHeader = doc.getElementById(AccessConnectorButton.PANEL_HEADER_ID);
    let panelMessage = doc.getElementById(
      AccessConnectorButton.PANEL_MESSAGE_ID
    );
    if (panelHeader && panelMessage) {
      doc.l10n.setAttributes(
        panelHeader,
        isError
          ? "access-connector-panel-header-error"
          : "access-connector-panel-header"
      );
      doc.l10n.setAttributes(
        panelMessage,
        isError
          ? "access-connector-panel-message-error"
          : "access-connector-panel-message"
      );
    }
  }

  /**
   * Submits a security event for a proxy error incident.
   *
   * @param {string} domain
   *  The hostname that failed to load through the proxy.
   */
  #recordProxyError(domain) {
    Glean.accessConnector.proxyError.record({ domain });
    GleanPings.enterprise.submit();
  }

  /**
   * Cleans up listeners and observers when the button is destroyed.
   */
  uninit() {
    let button = this.button;
    if (button) {
      button.removeEventListener("click", this.#onClick);
      button.hidden = true;
    }

    if (this.gBrowser && this.#progressListener) {
      this.gBrowser.removeTabsProgressListener(this.#progressListener);
    }
    this.#progressListener = null;

    if (this.gBrowser?.tabContainer) {
      this.gBrowser.tabContainer.removeEventListener("TabSelect", this);
    }

    lazy.IPProtectionService.removeEventListener(
      "IPProtectionService:StateChanged",
      this.handleEvent
    );
    lazy.IPPProxyManager.removeEventListener(
      "IPPProxyManager:StateChanged",
      this.handleEvent
    );
    lazy.IPPProxyManager.removeEventListener(
      "IPPProxyManager:ModeChanged",
      this.handleEvent
    );
    lazy.IPPSiteRuleManager.removeEventListener(
      "SiteRuleManager:RuleChanged",
      this.handleEvent
    );
  }
}
