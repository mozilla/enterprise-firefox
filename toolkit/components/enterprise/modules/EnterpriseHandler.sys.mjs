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
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  isTesting: "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("EnterpriseHandler");
});

const PROMPT_ON_SIGNOUT_PREF = "enterprise.prompt_on_signout";
const COMPANY_LOGO_URL_PREF = "enterprise.configs.company_logo_url";
const LEARN_MORE_URL_PREF = "enterprise.configs.learn_more_url";
const WARN_ON_CLOSE_PREF = "browser.tabs.warnOnClose";

/**
 * Parses a given url string
 *
 * @param {string} url url string from preference
 * @returns {URL|null} A parsed `URL` object if it's valid, otherwise `null`.
 */
function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    lazy.log.error(`Invalid URL: ${url}`);
    return null;
  }
}

/**
 * Validate that the URL is HTTPS.
 *
 * @param {string} url - The URL string to validate.
 * @returns {URL|null} A parsed `URL` object if validation succeeds, otherwise `null`.
 */
function validateHttpsUrl(url) {
  const parsedUrl = parseUrl(url);

  if (!parsedUrl) {
    return null;
  }

  const isLocalTest =
    lazy.isTesting() &&
    (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1");

  if (parsedUrl.protocol !== "https:" && !isLocalTest) {
    lazy.log.warn(`Expected HTTPS URL: ${url}`);
    return null;
  }

  return parsedUrl;
}

/**
 * Validates that a URL string is a base64-encoded data URL for a supported image type.
 *
 * Supported MIME types are PNG, JPEG, GIF, WebP, and SVG.
 *
 * If validation fails, an error is logged and `null` is returned.
 *
 * @param {string} url - The URL string to validate.
 * @returns {URL|null} A parsed `URL` object if validation succeeds, otherwise `null`.
 */
function validateDataUrl(url) {
  const parsedUrl = parseUrl(url);

  if (!parsedUrl) {
    return null;
  }

  const isSupportedImageDataUrl =
    parsedUrl.protocol === "data:" &&
    /^image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/.test(parsedUrl.pathname);

  if (!isSupportedImageDataUrl) {
    lazy.log.error(
      `Expected a base64-encoded supported image data URL: ${url}`
    );
    return null;
  }
  return parsedUrl;
}

export const EnterpriseHandler = {
  /**
   * @type {{name:string, email:string, pictureUrl:string} | null}
   */
  _signedInUser: null,

  /**
   * Whether the handler is initialized, meaning the user information
   * from the signed in user has been received from the console.
   */
  _isInitialized: false,

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
   * On first call:
   *    - Make a request to the console to retrieve the user information of the signed in user.
   * On every call:
   *    - Hide FxA toolbar button and FxA item in app menu (hamburger menu)
   *
   * @param {Window} window chrome window
   */
  async init(window) {
    if (Services.felt.isFeltUI()) {
      // Nothing to setup for the felt window
      return;
    }
    if (!this._isInitialized) {
      lazy.log.debug("Initializing...");
      await this.initUser();
      this._isInitialized = true;
    }
    this.updateBadge(window);
    this.restrictEnterpriseView(window);
    this._initUrlbarButtons(window);
  },

  async initUser() {
    try {
      const { name, email, picture } =
        await lazy.ConsoleClient.getLoggedInUserInfo();
      this._signedInUser = { name, email, pictureUrl: picture };
    } catch (e) {
      // TODO: Bug 2000864 - Handle unsuccessful GET /WHOAMI
      lazy.log.warn(
        "EnterpriseHandler: Unable to initialize enterprise user: ",
        e
      );
    }
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
   * Updates the user icon and badge logo
   *
   * @param {Window} window chrome window
   */
  updateBadge(window) {
    this._updateLogo(window);
    this._updateUserIcon(window);
  },

  /**
   * Updates the user icon in the enterprise badge
   *
   * If the signed-in user information is available:
   * - Uses the user's picture url (provided by the IdP) when available.
   * - Falls back to displaying user initials when no picture url is provided.
   * - Finally falls back to generic avatar icon if neither picture nor name available.
   *
   * Hides the user icon if no user information is currently available.
   *
   * @param {Window} window - The chrome window containing the enterprise UI elements.
   * @returns {void}
   */
  _updateUserIcon(window) {
    if (!this._signedInUser) {
      // No user information available so user icon remains hidden
      lazy.log.warn(
        "Unable to update user icon in badge without user information"
      );
      return;
    }

    const wrapper = window.document.getElementById(
      "enterprise-user-icon__wrapper"
    );
    const { name, pictureUrl } = this._signedInUser;
    if (pictureUrl) {
      const userIcon = window.document.querySelector(
        "#enterprise-user-icon__picture"
      );
      userIcon.style.setProperty("list-style-image", `url("${pictureUrl}")`);
      wrapper.dataset.userIconType = "picture";
    } else if (name) {
      // Fallback to user initials
      const initials = name.trim().charAt(0).toLocaleUpperCase();
      const initialsDiv = window.document.getElementById(
        "enterprise-user-icon__initials"
      );
      initialsDiv.textContent = initials;
      wrapper.dataset.userIconType = "initials";
    } else {
      wrapper.dataset.userIconType = "avatar";
    }
    wrapper.classList.remove("is-hidden");
  },

  /**
   * Retrieves and validates the learn more URL.
   * Returns null if the url is invalid.
   */
  _retrieveLearnMoreLink() {
    const learnMoreUrl = Services.prefs.getStringPref(LEARN_MORE_URL_PREF, "");

    if (!learnMoreUrl) {
      lazy.log.warn("No learn more url available.");
      return null;
    }

    return validateHttpsUrl(learnMoreUrl);
  },

  /**
   * Retrieves, validates, and applies the learn more URL to the link element.
   * Use fallback of "https://support.mozilla.org/kb/managed-browser-firefox" is no valid URL provided.
   *
   * @param {Window} win - chrome window
   * @returns {void}
   */
  _setupLearnMoreLink(win) {
    const validLearnMoreUrl =
      this._retrieveLearnMoreLink() ??
      parseUrl("https://support.mozilla.org/kb/managed-browser-firefox");

    const document = win.document;
    const viewNode = win.PanelMultiView.getViewNode(
      document,
      "panelUI-enterprise"
    );
    const learnMoreLink = viewNode.querySelector("#enterprise-learn-more-link");
    lazy.log.debug(`Setting learn more uri to ${validLearnMoreUrl.href}`);
    learnMoreLink.setAttribute("href", validLearnMoreUrl.href);

    learnMoreLink.addEventListener("click", e => {
      let where = lazy.BrowserUtils.whereToOpenLink(e, false, false);
      if (where == "current") {
        where = "tab";
      }
      win.openTrustedLinkIn(validLearnMoreUrl.href, where);
      e.preventDefault();

      const panel = viewNode.closest("panel");
      win.PanelMultiView.hidePopup(panel);
    });
  },

  openPanel(element, event) {
    const win = element.documentGlobal;
    win.PanelUI.showSubView("panelUI-enterprise", element, event);
    const document = element.ownerDocument;
    const viewNode = win.PanelMultiView.getViewNode(
      document,
      "panelUI-enterprise"
    );

    if (!element._isEnterpriseLearnMoreLinkConfigured) {
      this._setupLearnMoreLink(win);
      element._isEnterpriseLearnMoreLinkConfigured = true;
    }

    const email = viewNode.querySelector(".panelUI-enterprise__email");
    if (!this._signedInUser) {
      email.hidden = true;
      viewNode.querySelector("#PanelUI-enterprise-email-separator").hidden =
        true;
      lazy.log.warn(
        "Unable to update email in enterprise panel without user information"
      );
      return;
    }

    if (!email.textContent) {
      email.textContent = this._signedInUser.email;
    }
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
    const hasMultipleTabs = tabCount > 1;
    const hasTabsWarning = hasMultipleTabs && warnOnCloseWithTabs;

    let titleId, messageId;
    if (hasTabsWarning) {
      const warnSuffix = warnOnSignout ? "-and-signout-warning" : "";
      titleId = {
        id: `enterprise-close-prompt-title-with-tabcount${warnSuffix}`,
        args: { tabCount },
      };
      messageId = {
        id: `enterprise-close-prompt-message-with-tabcount${warnSuffix}`,
        args: warnOnSignout ? { tabCount } : {},
      };
    } else {
      titleId = { id: "enterprise-close-prompt-title" };
      messageId = { id: "enterprise-close-prompt-message" };
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
      { id: "enterprise-close-prompt-primary-btn-label" },
      { id: "enterprise-close-prompt-message-reauth" },
      { id: "enterprise-close-prompt-checkbox-label" },
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
      reauthNotice: warnOnSignout ? reauthNotice : null,
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
   * Determines whether the signout/close prompt should be shown based on preferences and current state.
   *
   * @returns {boolean} True if the prompt should be shown, false otherwise.
   */
  shouldShowClosePrompt() {
    if (this._skipSignoutPrompt) {
      this._skipSignoutPrompt = false;
      return false;
    }
    const warnOnSignout = Services.prefs.getBoolPref(
      PROMPT_ON_SIGNOUT_PREF,
      true
    );
    const warnOnCloseWithTabs = Services.prefs.getBoolPref(
      WARN_ON_CLOSE_PREF,
      false
    );
    if (!warnOnSignout && !warnOnCloseWithTabs) {
      return false;
    }
    this._tabCount = this._countOpenTabs();
    return warnOnSignout || this._tabCount > 1;
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

    this.initiateShutdown();
  },

  initiateShutdown() {
    // TODO: Bug 2001029 - Assert or force-enable session restore?
    try {
      Services.felt.performSignout();
    } catch (e) {
      lazy.log.error(`Unable to signout the user: ${e}`);
      Services.obs.notifyObservers(null, "felt-firefox-shutdown");
    }
    // FELT will call shutdownFirefox() to quit us after handling the logout.
  },

  uninit() {
    this._signedInUser = {};
    this._isInitialized = false;
  },

  _updateLogo(window) {
    const logoUrl = Services.prefs.getStringPref(COMPANY_LOGO_URL_PREF, "");

    if (!logoUrl) {
      lazy.log.warn(
        `Unable to retrieve company logo url from: ${COMPANY_LOGO_URL_PREF}`
      );
      return;
    }

    const validLogoUrl = validateDataUrl(logoUrl);

    if (validLogoUrl !== null) {
      const toolbarLogoWrapper = window.document.querySelector(
        "#enterprise-company-logo__wrapper"
      );
      const toolbarLogo = toolbarLogoWrapper.querySelector("image");
      toolbarLogo.style.setProperty(
        "list-style-image",
        `url("${validLogoUrl.href}")`
      );
      toolbarLogoWrapper.classList.remove("is-hidden");
    }
  },
};
