/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  IPPEnrollAndEntitleManager:
    "moz-src:///browser/components/ipprotection/IPPEnrollAndEntitleManager.sys.mjs",
  IPPExceptionsManager:
    "moz-src:///browser/components/ipprotection/IPPExceptionsManager.sys.mjs",
  IPPProxyManager:
    "moz-src:///browser/components/ipprotection/IPPProxyManager.sys.mjs",
  IPPProxyStates:
    "moz-src:///browser/components/ipprotection/IPPProxyManager.sys.mjs",
  IPProtectionService:
    "moz-src:///browser/components/ipprotection/IPProtectionService.sys.mjs",
  IPProtection:
    "moz-src:///browser/components/ipprotection/IPProtection.sys.mjs",
  IPPSignInWatcher:
    "moz-src:///browser/components/ipprotection/IPPSignInWatcher.sys.mjs",
  IPProtectionStates:
    "moz-src:///browser/components/ipprotection/IPProtectionService.sys.mjs",
});
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

import {
  LINKS,
  ERRORS,
} from "chrome://browser/content/ipprotection/ipprotection-constants.mjs";

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "BANDWIDTH_USAGE_ENABLED",
  "browser.ipProtection.bandwidth.enabled",
  false
);

let hasCustomElements = new WeakSet();

/**
 * Manages updates for a IP Protection panelView in a given browser window.
 */
export class IPProtectionPanel {
  static CONTENT_TAGNAME = "ipprotection-content";
  static CUSTOM_ELEMENTS_SCRIPT =
    "chrome://browser/content/ipprotection/ipprotection-customelements.js";
  static WIDGET_ID = "ipprotection-button";
  static PANEL_ID = "PanelUI-ipprotection";
  static TITLE_L10N_ID = "ipprotection-title";
  static HEADER_AREA_ID = "PanelUI-ipprotection-header";
  static CONTENT_AREA_ID = "PanelUI-ipprotection-content";
  static HEADER_BUTTON_ID = "ipprotection-header-button";

  /**
   * Loads the ipprotection custom element script
   * into a given window.
   *
   * Called on IPProtection.init for a new browser window.
   *
   * @param {Window} window
   */
  static loadCustomElements(window) {
    if (hasCustomElements.has(window)) {
      // Don't add the elements again for the same window.
      return;
    }
    Services.scriptloader.loadSubScriptWithOptions(
      IPProtectionPanel.CUSTOM_ELEMENTS_SCRIPT,
      {
        target: window,
        async: true,
      }
    );
    hasCustomElements.add(window);
  }

  /**
   * @typedef {object} State
   * @property {boolean} isProtectionEnabled
   *  The timestamp in milliseconds since IP Protection was enabled
   * @property {boolean} isSignedOut
   *  True if not signed in to account
   * @property {object} location
   *  Data about the server location the proxy is connected to
   * @property {string} location.name
   *  The location country name
   * @property {string} location.code
   *  The location country code
   * @property {"generic" | ""} error
   *  The error type as a string if an error occurred, or empty string if there are no errors.
   * @property {boolean} isAlpha
   *  True if we're running the Alpha variant, else false.
   * @property {boolean} hasUpgraded
   *  True if a Mozilla VPN subscription is linked to the user's Mozilla account.
   * @property {string} onboardingMessage
   * Continuous onboarding message to display in-panel, empty string if none applicable
   * @property {boolean} paused
   * True if the VPN service has been paused due to bandwidth limits
   * @property {boolean} isSiteExceptionsEnabled
   * True if site exceptions support is enabled, else false.
   * @property {object} siteData
   * Data about the currently loaded site, including "isExclusion".
   * @property {object} bandwidthUsage
   *  An object containing the current and max usage
   * @property {boolean} isActivating
   *  True if the VPN service is in the process of connecting, else false.
   */

  /**
   * @type {State}
   */
  state = {};
  panel = null;
  initiatedUpgrade = false;
  #window = null;

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
   * Check the state of the enclosing panel to see if
   * it is active (open or showing).
   */
  get active() {
    let panelParent = this.panel?.closest("panel");
    if (!panelParent) {
      return false;
    }
    return panelParent.state == "open" || panelParent.state == "showing";
  }

  /**
   * Gets the value of the pref
   * browser.ipProtection.features.siteExceptions.
   */
  get isExceptionsFeatureEnabled() {
    return Services.prefs.getBoolPref(
      "browser.ipProtection.features.siteExceptions",
      false
    );
  }

  /**
   * Creates an instance of IPProtectionPanel for a specific browser window.
   *
   * Inserts the panel component customElements registry script.
   *
   * @param {Window} window
   *   Window containing the panelView to manage.
   */
  constructor(window) {
    this.#window = Cu.getWeakReference(window);

    this.handleEvent = this.#handleEvent.bind(this);

    this.state = {
      isSignedOut: !lazy.IPPSignInWatcher.isSignedIn,
      unauthenticated:
        lazy.IPProtectionService.state ===
        lazy.IPProtectionStates.UNAUTHENTICATED,
      isProtectionEnabled:
        lazy.IPPProxyManager.state === lazy.IPPProxyStates.ACTIVE,
      location: {
        name: "United States",
        code: "us",
      },
      error: "",
      isAlpha: lazy.IPPEnrollAndEntitleManager.isAlpha,
      hasUpgraded: lazy.IPPEnrollAndEntitleManager.hasUpgraded,
      onboardingMessage: "",
      bandwidthWarning: "",
      paused: false,
      isSiteExceptionsEnabled: this.isExceptionsFeatureEnabled,
      siteData: this.#getSiteData(),
      bandwidthUsage: lazy.BANDWIDTH_USAGE_ENABLED
        ? { currentBandwidthUsage: 0, maxBandwidth: 150 }
        : null,
      isActivating:
        lazy.IPPProxyManager.state === lazy.IPPProxyStates.ACTIVATING,
    };

    // The progress listener to listen for page navigations.
    // Used to update the siteData state property for site exclusions.
    this.progressListener = {
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

        // Only update if on the currently selected tab
        if (aBrowser !== this.gBrowser?.selectedBrowser) {
          return;
        }

        if (this.active && aLocationURI) {
          this.#updateSiteData();
        }
      },
    };

    const win = this.#window.get();
    if (win) {
      IPProtectionPanel.loadCustomElements(win);
    }

    this.#addProxyListeners();
    this.#addProgressListener();
  }

  /**
   * Set the state for this panel.
   *
   * Updates the current panel component state,
   * if the panel is currently active (showing or not hiding).
   *
   * @example
   * panel.setState({
   *  isSomething: true,
   * });
   *
   * @param {object} state
   *    The state object from IPProtectionPanel.
   */
  setState(state) {
    Object.assign(this.state, state);

    if (this.active) {
      this.updateState();
    }
  }

  /**
   * Updates the state of the panel component.
   *
   * @param {object} state
   *   The state object from IPProtectionPanel.
   * @param {Element} panelEl
   *   The panelEl element to update the state on.
   */
  updateState(state = this.state, panelEl = this.panel) {
    if (!panelEl?.isConnected || !panelEl.state) {
      return;
    }

    panelEl.state = state;
    panelEl.requestUpdate();
  }

  #startProxy() {
    lazy.IPPProxyManager.start();
  }

  #stopProxy() {
    lazy.IPPProxyManager.stop();
  }

  /**
   * Opens the help page in a new tab and closes the panel.
   *
   * @param {Event} e
   */
  static showHelpPage(e) {
    let win = e.target?.ownerGlobal;
    if (win) {
      win.openWebLinkIn(LINKS.SUPPORT_URL, "tab");
    }

    let panelParent = e.target?.closest("panel");
    if (panelParent) {
      panelParent.hidePopup();
    }
  }

  /**
   * Updates the visibility of the panel components before they will shown.
   *
   * - If the panel component has already been created, updates the state.
   * - Creates a panel component if need, state will be updated on once it has
   *   been connected.
   *
   * @param {XULElement} panelView
   *   The panelView element from the CustomizableUI widget callback.
   */
  showing(panelView) {
    if (this.initiatedUpgrade) {
      lazy.IPPEnrollAndEntitleManager.refetchEntitlement();
      this.initiatedUpgrade = false;
    }

    this.#updateSiteData();
    this.setState({
      isSiteExceptionsEnabled: this.isExceptionsFeatureEnabled,
    });

    if (this.panel) {
      this.updateState();
    } else {
      this.#createPanel(panelView);
    }

    // TODO: Stop counting after all onboarding messages have been shown - Bug 1997332
    let currentCount = Services.prefs.getIntPref(
      "browser.ipProtection.panelOpenCount"
    );
    let updatedCount = currentCount + 1;
    Services.prefs.setIntPref(
      "browser.ipProtection.panelOpenCount",
      updatedCount
    );
  }

  /**
   * Called when the panel elements will be hidden.
   *
   * Disables updates to the panel.
   */
  hiding() {
    this.destroy();
  }

  /**
   * Creates a panel component in a panelView.
   *
   * @param {MozBrowser} panelView
   */
  #createPanel(panelView) {
    let { ownerDocument } = panelView;

    let headerArea = panelView.querySelector(
      `#${IPProtectionPanel.HEADER_AREA_ID}`
    );
    let headerButton = headerArea.querySelector(
      `#${IPProtectionPanel.HEADER_BUTTON_ID}`
    );
    if (!headerButton) {
      headerButton = this.#createHeaderButton(ownerDocument);
      headerArea.appendChild(headerButton);
    }
    // Reset the tab index to ensure it is focusable.
    headerButton.setAttribute("tabindex", "0");

    let contentEl = ownerDocument.createElement(
      IPProtectionPanel.CONTENT_TAGNAME
    );
    this.panel = contentEl;

    contentEl.dataset.capturesFocus = "true";

    this.#addPanelListeners(ownerDocument);

    let contentArea = panelView.querySelector(
      `#${IPProtectionPanel.CONTENT_AREA_ID}`
    );
    contentArea.appendChild(contentEl);
  }

  #createHeaderButton(ownerDocument) {
    const headerButton = ownerDocument.createXULElement("toolbarbutton");

    headerButton.id = IPProtectionPanel.HEADER_BUTTON_ID;
    headerButton.className = "panel-info-button";
    headerButton.dataset.capturesFocus = "true";

    ownerDocument.l10n.setAttributes(headerButton, "ipprotection-help-button");
    headerButton.addEventListener("click", IPProtectionPanel.showHelpPage);
    headerButton.addEventListener("keypress", e => {
      if (e.code == "Space" || e.code == "Enter") {
        IPProtectionPanel.showHelpPage(e);
      }
    });
    return headerButton;
  }

  /**
   * Open the IP Protection panel in the given window.
   *
   * @param {Window} window - which window to open the panel in.
   * @returns {Promise<void>}
   */
  async open(window) {
    if (!lazy.IPProtection.created || !window?.PanelUI) {
      return;
    }

    let widget = lazy.CustomizableUI.getWidget(IPProtectionPanel.WIDGET_ID);
    let anchor = widget.forWindow(window).anchor;
    await window.PanelUI.showSubView(IPProtectionPanel.PANEL_ID, anchor);
  }

  /**
   * Close the containing panel popup.
   */
  close() {
    let panelParent = this.panel?.closest("panel");
    if (!panelParent) {
      return;
    }
    panelParent.hidePopup();
  }

  /**
   * Start flow for signing in and then opening the panel on success
   */
  async startLoginFlow() {
    let window = this.panel.ownerGlobal;
    let browser = window.gBrowser;
    this.close();
    let isSignedIn = await lazy.IPProtectionService.startLoginFlow(browser);
    if (isSignedIn) {
      await this.open(window);
    }
  }

  /**
   * Remove added elements and listeners.
   */
  destroy() {
    if (this.panel) {
      this.panel.remove();
      this.#removePanelListeners(this.panel.ownerDocument);
      this.panel = null;
      if (this.state.error) {
        this.setState({
          error: "",
        });
      }
    }
  }

  uninit() {
    this.destroy();
    this.#removeProxyListeners();
    this.#removeProgressListener();
  }

  #addPanelListeners(doc) {
    doc.addEventListener("IPProtection:Init", this.handleEvent);
    doc.addEventListener("IPProtection:ClickUpgrade", this.handleEvent);
    doc.addEventListener("IPProtection:Close", this.handleEvent);
    doc.addEventListener("IPProtection:UserEnable", this.handleEvent);
    doc.addEventListener("IPProtection:UserDisable", this.handleEvent);
    doc.addEventListener("IPProtection:OptIn", this.handleEvent);
    doc.addEventListener("IPProtection:UserEnableVPNForSite", this.handleEvent);
    doc.addEventListener(
      "IPProtection:UserDisableVPNForSite",
      this.handleEvent
    );
  }

  #removePanelListeners(doc) {
    doc.removeEventListener("IPProtection:Init", this.handleEvent);
    doc.removeEventListener("IPProtection:ClickUpgrade", this.handleEvent);
    doc.removeEventListener("IPProtection:Close", this.handleEvent);
    doc.removeEventListener("IPProtection:UserEnable", this.handleEvent);
    doc.removeEventListener("IPProtection:UserDisable", this.handleEvent);
    doc.removeEventListener("IPProtection:OptIn", this.handleEvent);
    doc.removeEventListener(
      "IPProtection:UserEnableVPNForSite",
      this.handleEvent
    );
    doc.removeEventListener(
      "IPProtection:UserDisableVPNForSite",
      this.handleEvent
    );
  }

  #addProxyListeners() {
    lazy.IPProtectionService.addEventListener(
      "IPProtectionService:StateChanged",
      this.handleEvent
    );
    lazy.IPPProxyManager.addEventListener(
      "IPPProxyManager:StateChanged",
      this.handleEvent
    );
    lazy.IPPEnrollAndEntitleManager.addEventListener(
      "IPPEnrollAndEntitleManager:StateChanged",
      this.handleEvent
    );
    lazy.IPPExceptionsManager.addEventListener(
      "IPPExceptionsManager:ExclusionChanged",
      this.handleEvent
    );
  }

  #removeProxyListeners() {
    lazy.IPPEnrollAndEntitleManager.removeEventListener(
      "IPPEnrollAndEntitleManager:StateChanged",
      this.handleEvent
    );
    lazy.IPPProxyManager.removeEventListener(
      "IPPProxyManager:StateChanged",
      this.handleEvent
    );
    lazy.IPProtectionService.removeEventListener(
      "IPProtectionService:StateChanged",
      this.handleEvent
    );
    lazy.IPPExceptionsManager.removeEventListener(
      "IPPExceptionsManager:ExclusionChanged",
      this.handleEvent
    );
  }

  #addProgressListener() {
    if (this.gBrowser) {
      this.gBrowser.addTabsProgressListener(this.progressListener);
    }
  }

  #removeProgressListener() {
    if (this.gBrowser) {
      this.gBrowser.removeTabsProgressListener(this.progressListener);
    }
  }

  /**
   * Gets siteData by reading the current content principal.
   *
   * @returns {object|null}
   *  An object with data relevant to a site (eg. isExclusion),
   *  or null otherwise if invalid.
   *
   * @see State.siteData
   */

  #getSiteData() {
    const principal = this.gBrowser?.contentPrincipal;

    if (!principal) {
      return null;
    }

    const isExclusion = lazy.IPPExceptionsManager.hasExclusion(principal);
    const isPrivileged = this._isPrivilegedPage(principal);

    let siteData = !isPrivileged ? { isExclusion } : null;
    return siteData;
  }

  /**
   * Checks if the given principal represents a privileged page.
   *
   * @param {nsIPrincipal} principal
   *  The principal to evaluate.
   * @returns {boolean}
   *  True if the page is privileged (about: pages or system principal).
   */
  _isPrivilegedPage(principal) {
    // Ignore about: pages for automated tests, which load in about:blank pages by default.
    // Do not register this method as private though so that we can stub it.
    return (
      (principal.schemeIs("about") || principal.isSystemPrincipal) &&
      !Cu.isInAutomation
    );
  }

  /**
   * Updates the siteData state property.
   */
  #updateSiteData() {
    const siteData = this.#getSiteData();
    this.setState({ siteData });
  }

  #reloadCurrentTab(win) {
    if (!win) {
      return;
    }
    win.gBrowser.reloadTab(win.gBrowser.selectedTab);
  }

  #handleEvent(event) {
    if (event.type == "IPProtection:Init") {
      this.updateState();
    } else if (event.type == "IPProtection:Close") {
      this.close();
    } else if (event.type == "IPProtection:UserEnable") {
      this.#startProxy();
      Services.prefs.setBoolPref("browser.ipProtection.userEnabled", true);
      let userEnableCount = Services.prefs.getIntPref(
        "browser.ipProtection.userEnableCount",
        0
      );
      if (userEnableCount < 3) {
        Services.prefs.setIntPref(
          "browser.ipProtection.userEnableCount",
          userEnableCount + 1
        );
      }
    } else if (event.type == "IPProtection:UserDisable") {
      this.#stopProxy();
      Services.prefs.setBoolPref("browser.ipProtection.userEnabled", false);
    } else if (event.type == "IPProtection:ClickUpgrade") {
      // Let the service know that we tried upgrading at least once
      this.initiatedUpgrade = true;
      this.close();
    } else if (event.type == "IPProtection:OptIn") {
      this.startLoginFlow();
    } else if (
      event.type == "IPPProxyManager:StateChanged" ||
      event.type == "IPProtectionService:StateChanged" ||
      event.type === "IPPEnrollAndEntitleManager:StateChanged"
    ) {
      let hasError =
        lazy.IPPProxyManager.state === lazy.IPPProxyStates.ERROR &&
        lazy.IPPProxyManager.errors.includes(ERRORS.GENERIC);

      this.setState({
        isSignedOut: !lazy.IPPSignInWatcher.isSignedIn,
        unauthenticated:
          lazy.IPProtectionService.state ===
          lazy.IPProtectionStates.UNAUTHENTICATED,
        isProtectionEnabled:
          lazy.IPPProxyManager.state === lazy.IPPProxyStates.ACTIVE,
        hasUpgraded: lazy.IPPEnrollAndEntitleManager.hasUpgraded,
        error: hasError ? ERRORS.GENERIC : "",
        isActivating:
          lazy.IPPProxyManager.state === lazy.IPPProxyStates.ACTIVATING,
      });
    } else if (event.type == "IPPExceptionsManager:ExclusionChanged") {
      this.#updateSiteData();
    } else if (event.type == "IPProtection:UserEnableVPNForSite") {
      const win = event.target.ownerGlobal;
      const principal = win?.gBrowser.contentPrincipal;

      lazy.IPPExceptionsManager.setExclusion(principal, false);

      this.#reloadCurrentTab(win);
    } else if (event.type == "IPProtection:UserDisableVPNForSite") {
      const win = event.target.ownerGlobal;
      const principal = win?.gBrowser.contentPrincipal;

      lazy.IPPExceptionsManager.setExclusion(principal, true);

      this.#reloadCurrentTab(win);
    }
  }
}
