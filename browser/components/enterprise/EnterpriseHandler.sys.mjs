/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "localization", () => {
  return new Localization(
    ["toolkit/enterprise/enterprise.ftl", "branding/brand.ftl"],
    true
  );
});

ChromeUtils.defineESModuleGetters(lazy, {
  initiateShutdown:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("EnterpriseHandler");
});

const PROMPT_ON_SIGNOUT_PREF = "enterprise.prompt_on_signout";
const WARN_ON_CLOSE_PREF = "browser.tabs.warnOnClose";
const LOCK_ENABLED_PREF = "enterprise.session.locking.enabled";
const LOCK_ON_CLOSE_PREF = "enterprise.session.locking.on_close";

export const EnterpriseHandler = {
  /**
   * Set to true after the user confirms the enterprise close dialog, so that the
   * resulting re-quit skips showing it again.
   */
  _skipSignoutPrompt: false,

  /**
   * Cached count of open tabs used when showing the close prompt to avoid recounting
   * tabs multiple times during the prompt flow. Resets to null after use.
   */
  _tabCount: null,

  /**
   * Handles the enterprise state for each new browser window.
   * On every call:
   *    - Initializes the URL bar buttons on every call
   *    - Hide FxA toolbar button and FxA item in app menu (hamburger menu)
   *
   * @param {Window} window chrome window
   */
  init(window) {
    if (Services.felt.isFeltUI()) {
      // Nothing to setup for the felt window
      return;
    }
    this.restrictEnterpriseView(window);
    this._initUrlbarButtons(window);
  },

  /**
   * Initializes the enterprise-related urlbar buttons.
   *
   * @param {Window} window chrome window
   */
  _initUrlbarButtons(window) {
    this._initLockdownModeButton(window);
  },

  /**
   * Initializes the lockdown mode button in the urlbar.
   *
   * The button will be visible based on whether the current page is in lockdown mode, as determined by the JIT policy state for the page's URI.
   *
   * @param {Window} window chrome window
   */
  _initLockdownModeButton(window) {
    const button = window.document.getElementById("lockdown-mode-button");

    button.addEventListener("click", event => {
      window.PanelUI.showSubView("panelUI-lockdown-mode", button, event);
    });

    window.gBrowser.addProgressListener({
      onLocationChange(webProgress, _request, location) {
        if (!webProgress.isTopLevel) {
          return;
        }
        let isLockedDown = false;
        try {
          isLockedDown = Services.policies.hasSitePoliciesForURI(location);
        } catch (e) {
          lazy.log.warn("Failed to check lockdown state for URI: ", e);
        }
        button.hidden = !isLockedDown;
      },
    });
  },

  /**
   * Hide away FxA appearances in the toolbar and the app menu (hamburger menu)
   *
   * @param {Window} window chrome window
   */
  restrictEnterpriseView(window) {
    // Hides fxa toolbar button
    Services.prefs.setBoolPref("identity.fxaccounts.toolbar.enabled", false);

    // Hides fxa item and separator in main view (hamburg menu)
    window.PanelUI.mainView.setAttribute("restricted-enterprise-view", true);
  },

  /**
   * Generates the parameters for the signout/close prompt based on the current state and preferences.
   *
   * @param {object} options
   * @param {number} options.tabCount - The number of open tabs across all windows.
   * @param {boolean} options.warnOnSignout - Whether to warn on signout.
   * @param {boolean} options.warnOnCloseWithTabs - Whether to warn on close when multiple tabs are open.
   * @returns {Promise<object>} The parameters for the signout/close prompt, including title, message, checkbox states, and more.
   */
  async _getSignoutPromptParams({
    tabCount,
    warnOnSignout,
    warnOnCloseWithTabs,
  } = {}) {
    const lockOnClose = this.willLockOnClose;
    const hasMultipleTabs = tabCount > 1;
    const hasTabsWarning = hasMultipleTabs && warnOnCloseWithTabs;
    const lockSuffix = lockOnClose ? "-lock" : "";

    let titleId, messageId;
    if (hasTabsWarning) {
      const warnSuffix = warnOnSignout ? "-and-signout-warning" : "";
      titleId = {
        id: `enterprise-close-prompt-title-with-tabcount${warnSuffix}`,
        args: { tabCount },
      };
      // Titles are action-neutral; only the message reflects lock vs sign-out.
      const tabsLockSuffix = warnOnSignout ? "-and-lock-warning" : "-lock";
      messageId = {
        id: `enterprise-close-prompt-message-with-tabcount${
          lockOnClose ? tabsLockSuffix : warnSuffix
        }`,
        args: warnOnSignout ? { tabCount } : {},
      };
    } else {
      titleId = { id: "enterprise-close-prompt-title" };
      messageId = { id: `enterprise-close-prompt-message${lockSuffix}` };
    }

    const [
      title,
      message,
      acceptLabel,
      reauthNotice,
      checkLabel,
      tabsCheckLabel,
    ] = await lazy.localization.formatValues([
      titleId,
      messageId,
      { id: `enterprise-close-prompt-primary-btn-label${lockSuffix}` },
      { id: `enterprise-close-prompt-message${lockSuffix}-reauth` },
      { id: `enterprise-close-prompt-checkbox-label${lockSuffix}` },
      { id: "enterprise-close-prompt-tabs-checkbox-label" },
    ]);

    const checkboxes = [
      { id: "warnOnSignout", label: checkLabel, checked: warnOnSignout },
      ...(hasMultipleTabs
        ? [
            {
              id: "warnOnCloseWithTabs",
              label: tabsCheckLabel,
              checked: warnOnCloseWithTabs,
            },
          ]
        : []),
    ];

    return {
      title,
      message,
      // When locking, the resume notice is always shown; when signing out it is
      // only shown if the user opted into sign-out warnings.
      reauthNotice: lockOnClose || warnOnSignout ? reauthNotice : null,
      acceptLabel,
      checkboxes,
      accepted: false,
    };
  },

  /**
   * Handles the result of the signout/close prompt, updating preferences based on checkbox states if accepted.
   *
   * @param {boolean} accepted - Whether the user accepted the prompt.
   * @param {Array<{id: string, checked: boolean}>} checkboxes - The state of the checkboxes in the prompt.
   * @returns {boolean} True if the action should proceed (accepted), false if cancelled.
   */
  _handleSignoutPromptResult(accepted, checkboxes) {
    if (!accepted) {
      return false;
    }

    for (const { id, checked } of checkboxes) {
      if (id === "warnOnSignout") {
        Services.prefs.setBoolPref(PROMPT_ON_SIGNOUT_PREF, checked);
      } else if (id === "warnOnCloseWithTabs") {
        Services.prefs.setBoolPref(WARN_ON_CLOSE_PREF, checked);
      }
    }

    return true;
  },

  /**
   * Counts the total number of open tabs across all browser windows.
   *
   * @returns {number} The total count of open tabs.
   */
  _countOpenTabs() {
    let tabCount = 0;
    for (let win of Services.wm.getEnumerator("navigator:browser")) {
      if (!win.closed && win.gBrowser) {
        tabCount += win.gBrowser.openTabs.length;
      }
    }
    return tabCount;
  },

  /**
   * Whether to run the close flow, or let the re-quit from an already-started
   * enterprise shutdown through.
   *
   * @returns {boolean} True to run the close flow, false while an enterprise
   *   shutdown is already underway so its re-quit proceeds.
   */
  shouldHandleClose() {
    if (this._skipSignoutPrompt) {
      this._skipSignoutPrompt = false;
      return false;
    }
    return true;
  },

  /**
   * Shows the signout/close confirmation dialog if needed.
   *
   * @param {Window} window
   * @returns {Promise<boolean>} true if the action should proceed, false if cancelled.
   */
  async showSignoutPrompt(window) {
    const warnOnSignout = Services.prefs.getBoolPref(
      PROMPT_ON_SIGNOUT_PREF,
      true
    );
    const warnOnCloseWithTabs = Services.prefs.getBoolPref(
      WARN_ON_CLOSE_PREF,
      false
    );

    this._tabCount ??= this._countOpenTabs();

    if (!warnOnSignout && (this._tabCount <= 1 || !warnOnCloseWithTabs)) {
      this._tabCount = null;
      return true;
    }

    const params = await this._getSignoutPromptParams({
      tabCount: this._tabCount,
      warnOnSignout,
      warnOnCloseWithTabs,
    });
    this._tabCount = null;

    if (!window) {
      params.wrappedJSObject = params;
      Services.ww.openWindow(
        null,
        // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
        "chrome://browser/content/enterprise/enterprise-close-dialog.xhtml",
        "_blank",
        "chrome,centerscreen,modal,dialog",
        params
      );
    } else {
      if (window.gDialogBox.isOpen) {
        window.gDialogBox.replaceDialogIfOpen();
      }
      await window.gDialogBox.open(
        // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
        "chrome://browser/content/enterprise/enterprise-close-dialog.xhtml",
        params
      );
    }

    const accepted = this._handleSignoutPromptResult(
      params.accepted,
      params.checkboxes
    );
    if (accepted) {
      this._skipSignoutPrompt = true;
    }
    return accepted;
  },

  /**
   * Handles the signout button in the enterprise panel. Shows the signout
   * confirmation dialog then performs a full signout and quits.
   *
   * @param {Window} window
   */
  async onSignOut(window) {
    if (!(await this.showSignoutPrompt(window))) {
      return;
    }

    lazy.initiateShutdown();
  },

  /**
   * Whether closing the browser will lock the session (persist it behind OS
   * auth to resume later) rather than sign out, per the locking prefs.
   *
   * @returns {boolean}
   */
  get willLockOnClose() {
    return (
      Services.prefs.getBoolPref(LOCK_ENABLED_PREF, false) &&
      Services.prefs.getBoolPref(LOCK_ON_CLOSE_PREF, false)
    );
  },

  /**
   * Ends the FELT session on browser close by either locking it (persisting it
   * behind OS auth to resume later) or signing out.
   */
  lockOrSignOut() {
    this._skipSignoutPrompt = true;
    if (this.willLockOnClose) {
      try {
        Services.felt.performLock();
      } catch (e) {
        // performLock only throws when the browser-side FELT IPC client is
        // missing, which should not happen in a FELT browser. Fall back to a
        // regular close.
        lazy.log.warn(`Unable to lock, falling back to signout: ${e}`);
        Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
      }
      return;
    }

    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
  },
};
