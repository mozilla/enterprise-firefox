/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ERRORS } from "chrome://browser/content/ipprotection/ipprotection-constants.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  IPPExceptionsManager:
    "moz-src:///browser/components/ipprotection/IPPExceptionsManager.sys.mjs",
  IPPProxyManager:
    "moz-src:///browser/components/ipprotection/IPPProxyManager.sys.mjs",
  IPProtectionService:
    "moz-src:///browser/components/ipprotection/IPProtectionService.sys.mjs",
  IPPProxyStates:
    "moz-src:///browser/components/ipprotection/IPPProxyManager.sys.mjs",
});

/**
 * IPProtectionToolbarButton manages the IP Protection toolbar button
 * for a single browser window.
 *
 * Each instance:
 * - Tracks location changes via a progress listener
 * - Updates the button icon according to the proxy state, errors, and site exclusions
 * - Handles the visual state of the toolbar button
 */
export class IPProtectionToolbarButton {
  #window = null;
  #progressListener = null;
  #widgetId = null;

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

  constructor(window, widgetId, toolbaritem = null) {
    this.#window = Cu.getWeakReference(window);
    this.#widgetId = widgetId;
    this.handleEvent = this.#handleEvent.bind(this);

    this.#addProgressListener();
    lazy.IPProtectionService.addEventListener(
      "IPProtectionService:StateChanged",
      this.handleEvent
    );
    lazy.IPPProxyManager.addEventListener(
      "IPPProxyManager:StateChanged",
      this.handleEvent
    );

    if (this.gBrowser?.tabContainer) {
      this.gBrowser.tabContainer.addEventListener("TabSelect", this);
    }

    if (toolbaritem) {
      this.updateState(toolbaritem);
    }
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

        // Only update if on the currently selected tab
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
      event.type === "IPProtectionService:StateChanged" ||
      event.type === "IPPProxyManager:StateChanged"
    ) {
      this.updateState();
    } else if (event.type === "TabSelect") {
      this.updateState();
    }
  }

  /**
   * Updates the button to reflect the current state.
   *
   * This method is called under these circumstances:
   * 1. After creating the toolbar button, to set up the initial icon
   * 2. After an IPProtectionService or IPPProxyManager state change
   * 3. After pressing the site exclusion toggle on the panel and the
   *    exclusion state for a site has changed in ipp-vpn
   * 4. After a location change / page navigation
   * 5. After tab switching
   *
   * @param {XULElement|null} [toolbaritem]
   *  Optional toolbaritem to update directly.
   *  If not provided, looks up the toolbaritem via CustomizableUI.
   *  If provided, but toolbaritem is null, this means the toolbaritem isn't available yet.
   */
  updateState(toolbaritem = null) {
    const win = this.#window.get();
    if (!win) {
      return;
    }

    toolbaritem ??= lazy.CustomizableUI.getWidget(this.#widgetId)?.forWindow(
      win
    ).node;

    if (!toolbaritem) {
      return;
    }

    // Check the ipp-vpn permission using IPPExceptionsManager.
    let principal = this.gBrowser?.contentPrincipal;
    let isExcluded = this.#isExcludedSite(principal);

    let isActive = lazy.IPPProxyManager.state === lazy.IPPProxyStates.ACTIVE;
    let isError =
      lazy.IPPProxyManager.state === lazy.IPPProxyStates.ERROR &&
      lazy.IPPProxyManager.errors.includes(ERRORS.GENERIC);

    this.updateIconStatus(toolbaritem, {
      isActive,
      isError,
      isExcluded,
    });
  }

  /**
   * Updates the toolbar button icon to reflect the VPN connection status
   *
   * @param {XULElement} toolbaritem
   *  The toolbaritem to update
   * @param {object} status
   *  VPN connection status
   */
  updateIconStatus(
    toolbaritem,
    status = { isActive: false, isError: false, isExcluded: false }
  ) {
    let isActive = status.isActive;
    let isError = status.isError;
    let isExcluded = status.isExcluded;
    let l10nId = isError ? "ipprotection-button-error" : "ipprotection-button";

    toolbaritem.classList.remove(
      "ipprotection-on",
      "ipprotection-error",
      "ipprotection-excluded"
    );

    if (isError) {
      toolbaritem.classList.add("ipprotection-error");
    } else if (isExcluded && isActive) {
      toolbaritem.classList.add("ipprotection-excluded");
    } else if (isActive) {
      toolbaritem.classList.add("ipprotection-on");
    }

    toolbaritem.setAttribute("data-l10n-id", l10nId);
  }

  /**
   * Checks if the given principal is excluded from IP Protection.
   *
   * @param {nsIPrincipal} principal
   *  The principal to check.
   * @returns {boolean}
   *  True if the site is excluded, false otherwise.
   */
  #isExcludedSite(principal) {
    if (!principal || principal.isNullPrincipal) {
      return false;
    }

    return lazy.IPPExceptionsManager.hasExclusion(principal);
  }

  /**
   * Cleans up listeners when the button is destroyed.
   */
  uninit() {
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
  }
}
