/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  IPPProxyManager:
    "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPPPrincipalRules:
    "moz-src:///toolkit/components/ipprotection/IPPSiteRuleManager.sys.mjs",
  IPPSiteRuleManager:
    "moz-src:///toolkit/components/ipprotection/IPPSiteRuleManager.sys.mjs",
});

const BUTTON_ID = "access-connector-button";
const PANEL_ID = "panelUI-access-connector";
const PANEL_HEADER_ID = "access-connector-panel-header";
const PANEL_MESSAGE_ID = "access-connector-panel-message";

const PROXY_ERROR_CODES = new Set([
  "proxyConnectFailure",
  "proxyResolveFailure",
]);

/**
 * AccessConnectorButton manages the enterprise access connector urlbar button
 * for a single browser window.
 */
export class AccessConnectorButton {
  #window = null;
  #progressListener = null;
  #onClick = null;
  #lastErrorDomain = null;

  /**
   * @param {Window} window - The chrome window that owns the button.
   */
  constructor(window) {
    const button = window.document.getElementById(BUTTON_ID);
    if (!button) {
      return;
    }

    this.#window = Cu.getWeakReference(window);
    this.handleEvent = this.#handleEvent.bind(this);
    this.#onClick = event => {
      this.#window.get()?.PanelUI.showSubView(PANEL_ID, this.#button, event);
    };
    button.addEventListener("click", this.#onClick);

    this.#addProgressListener();
    window.gBrowser.tabContainer.addEventListener("TabSelect", this);

    lazy.IPPProxyManager.addEventListener(
      "IPPProxyManager:StateChanged",
      this.handleEvent
    );

    this.#update();
  }

  get gBrowser() {
    return this.#window?.get()?.gBrowser ?? null;
  }

  /**
   * Resolves the button element on demand from the window.
   *
   * @returns {Element|null}
   */
  get #button() {
    return this.#window?.get()?.document.getElementById(BUTTON_ID) ?? null;
  }

  /**
   * Registers a progress listener that updates the button on top-level,
   * non-same-document navigations in the selected tab.
   */
  #addProgressListener() {
    const gBrowser = this.gBrowser;
    if (!gBrowser) {
      return;
    }
    this.#progressListener = {
      onLocationChange: (browser, webProgress, _request, _location, flags) => {
        if (!webProgress.isTopLevel) {
          return;
        }
        if (browser !== this.gBrowser?.selectedBrowser) {
          return;
        }
        const isSameDocument =
          flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT;
        if (isSameDocument) {
          return;
        }
        this.#update();
      },
    };

    gBrowser.addTabsProgressListener(this.#progressListener);
  }

  /**
   * Routes TabSelect and IPPProxyManager:StateChanged events to a status update.
   *
   * @param {Event} _event
   */
  #handleEvent(_event) {
    this.#update();
  }

  /**
   * Recomputes the button status and applies it.
   */
  #update() {
    this.#applyStatus(this.#getStatus());
  }

  /**
   * Checks the current proxy status for the current page.
   *
   * @returns {{ isProtected: boolean, isError: boolean }}
   */
  #getStatus() {
    const principal = this.gBrowser?.selectedBrowser?.contentPrincipal;

    if (!lazy.IPPProxyManager.active) {
      return { isProtected: false, isError: false };
    }

    const rule = lazy.IPPSiteRuleManager.getRule(principal);
    if (rule === lazy.IPPPrincipalRules.INCLUDED) {
      return { isProtected: true, isError: false };
    }

    return this.#checkForProxyError(principal);
  }

  /**
   * Checks whether the given principal corresponds to a proxy error page.
   *
   * @param {*} principal - The principal to check, expected to be the content principal of the currently selected browser tab.
   * @returns {{ isProtected: boolean, isError: boolean }}
   */
  #checkForProxyError(principal) {
    const principalURI = principal?.URI;
    if (principalURI?.spec.startsWith("about:neterror")) {
      const params = new URLSearchParams(principalURI.query);
      const errorCode = params.get("e");
      if (PROXY_ERROR_CODES.has(errorCode)) {
        let domain = "";
        try {
          domain = new URL(params.get("u") ?? "").hostname;
        } catch {}
        return { isProtected: true, isError: true, domain };
      }
    }
    return { isProtected: false, isError: false, domain: "" };
  }

  /**
   * Shows the button when the page is protected by the access connector, and
   * applies error styling when the proxy is unavailable.
   *
   * @param {{ isProtected: boolean, isError: boolean, domain: string }} status
   */
  #applyStatus({ isProtected, isError, domain }) {
    const button = this.#button;
    if (!button) {
      return;
    }

    button.hidden = !isProtected;

    if (isError) {
      button.setAttribute("error", "true");
    } else {
      button.removeAttribute("error");
    }

    const doc = this.#window?.get()?.document;
    if (doc) {
      doc.l10n.setAttributes(
        button,
        isError ? "access-connector-button-error" : "access-connector-button"
      );

      const panelHeader = doc.getElementById(PANEL_HEADER_ID);
      const panelMessage = doc.getElementById(PANEL_MESSAGE_ID);
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

    if (isError && domain !== this.#lastErrorDomain) {
      this.#recordProxyError(domain);
    }
    this.#lastErrorDomain = isError ? domain : null;
  }

  /**
   * Submits a security event for a proxy error incident.
   *
   * @param {string} domain - The hostname that failed to load through the proxy.
   */
  #recordProxyError(domain) {
    Glean.accessConnector.proxyError.record({ domain });
    GleanPings.enterprise.submit();
  }

  /**
   * Removes all listeners owned by this instance.
   */
  uninit() {
    if (!this.#window) {
      return;
    }
    this.#button?.removeEventListener("click", this.#onClick);
    const gBrowser = this.gBrowser;
    if (gBrowser) {
      gBrowser.removeTabsProgressListener(this.#progressListener);
      gBrowser.tabContainer.removeEventListener("TabSelect", this);
    }
    lazy.IPPProxyManager.removeEventListener(
      "IPPProxyManager:StateChanged",
      this.handleEvent
    );
  }
}

/**
 * Per-window lifecycle entry point for the access connector button.
 */
export const AccessConnectorButtonHandler = {
  /**
   * @param {Window} window chrome window
   */
  init(window) {
    const button = new AccessConnectorButton(window);
    window.addEventListener("unload", () => button.uninit(), { once: true });
  },
};
