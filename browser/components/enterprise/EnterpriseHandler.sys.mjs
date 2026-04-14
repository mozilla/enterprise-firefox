/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "localization", () => {
  return new Localization(
    ["browser/enterprise/enterprise.ftl", "branding/brand.ftl"],
    true
  );
});

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  ConsoleClient: "resource:///modules/enterprise/ConsoleClient.sys.mjs",
  EnterpriseCommon: "resource:///modules/enterprise/EnterpriseCommon.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return console.createInstance({
    prefix: "EnterpriseHandler",
    maxLogLevelPref: lazy.EnterpriseCommon.ENTERPRISE_LOGLEVEL_PREF,
  });
});

const PROMPT_ON_SIGNOUT_PREF = "enterprise.prompt_on_signout";
const COMPANY_LOGO_URL_PREF = "enterprise.configs.company_logo_url";
const LEARN_MORE_URL_PREF = "enterprise.configs.learn_more_url";

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

  if (parsedUrl.protocol !== "https:") {
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
    this._initLockdownModeButton(window);
  },

  async initUser() {
    try {
      const { name, email, picture } =
        await lazy.ConsoleClient.getLoggedInUserInfo();
      this._signedInUser = { name, email, pictureUrl: picture };
    } catch (e) {
      // TODO: Bug 2000864 - Handle unsuccessful GET /WHOAMI
      console.warn(
        "EnterpriseHandler: Unable to initialize enterprise user: ",
        e
      );
    }
  },

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
          isLockedDown = !Services.policies.isAllowedForURI("jit", location);
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
    const learnMoreLink = document.getElementById("enterprise-learn-more-link");
    lazy.log.debug(`Setting learn more uri to ${validLearnMoreUrl.href}`);
    learnMoreLink.setAttribute("href", validLearnMoreUrl.href);

    learnMoreLink.addEventListener("click", e => {
      let where = lazy.BrowserUtils.whereToOpenLink(e, false, false);
      if (where == "current") {
        where = "tab";
      }
      win.openTrustedLinkIn(validLearnMoreUrl.href, where);
      e.preventDefault();

      const panel = document
        .getElementById("panelUI-enterprise")
        .closest("panel");
      win.PanelMultiView.hidePopup(panel);
    });
  },

  openPanel(element, event) {
    const win = element.ownerGlobal;
    win.PanelUI.showSubView("panelUI-enterprise", element, event);
    const document = element.ownerDocument;

    if (!element._isEnterpriseLearnMoreLinkConfigured) {
      this._setupLearnMoreLink(win);
      element._isEnterpriseLearnMoreLinkConfigured = true;
    }

    const email = document.querySelector(".panelUI-enterprise__email");
    if (!this._signedInUser) {
      email.hidden = true;
      document.querySelector("#PanelUI-enterprise-email-separator").hidden =
        true;
      console.warn(
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

  _getSignoutPromptParams() {
    let tabCount = 0;
    for (let win of Services.wm.getEnumerator("navigator:browser")) {
      if (!win.closed && win.gBrowser) {
        tabCount += win.gBrowser.openTabs.length;
      }
    }

    const titleId = {
      id: "enterprise-signout-prompt-title2",
      args: { tabCount },
    };

    return {
      titleId,
      messageId: { id: "enterprise-signout-prompt-message" },
      checkLabelId: { id: "enterprise-signout-prompt-checkbox-label" },
      signoutBtnLabelId: { id: "enterprise-signout-prompt-primary-btn-label" },
      flags:
        Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_0 +
        Services.prompt.BUTTON_TITLE_CANCEL * Services.prompt.BUTTON_POS_1 +
        Services.prompt.BUTTON_POS_0_DEFAULT,
    };
  },

  _handleSignoutPromptResult(buttonPressed, checked) {
    if (buttonPressed === 1) {
      return false;
    }
    if (!checked) {
      Services.prefs.setBoolPref(PROMPT_ON_SIGNOUT_PREF, false);
    }
    return true;
  },

  isSignoutPromptEnabled() {
    return Services.prefs.getBoolPref(PROMPT_ON_SIGNOUT_PREF, true);
  },

  /**
   * Synchronous signout prompt for the quit-application-requested observer,
   * which must return a result before the quit proceeds.
   *
   * @param {Window} window
   * @returns {boolean} true if quit should proceed, false if cancelled.
   */
  showSignoutPrompt(window) {
    if (!this.isSignoutPromptEnabled()) {
      return true;
    }

    const params = this._getSignoutPromptParams();
    const [title, message, checkLabel, signoutBtnLabel] =
      lazy.localization.formatValuesSync([
        params.titleId,
        params.messageId,
        params.checkLabelId,
        params.signoutBtnLabelId,
      ]);

    const checkState = { value: true };
    const buttonPressed = Services.prompt.confirmEx(
      window,
      title,
      message,
      params.flags,
      signoutBtnLabel,
      null,
      null,
      checkLabel,
      checkState
    );

    return this._handleSignoutPromptResult(buttonPressed, checkState.value);
  },

  /**
   * Handles the signout button in the enterprise panel. Shows an async
   * in-content dialog that does not block the parent process, then quits.
   *
   * @param {Window} window
   */
  async onSignOut(window) {
    if (!Services.prefs.getBoolPref(PROMPT_ON_SIGNOUT_PREF, true)) {
      await this.initiateShutdown();
      return;
    }

    const params = this._getSignoutPromptParams();
    const [title, message, checkLabel, signoutBtnLabel] =
      await lazy.localization.formatValues([
        params.titleId,
        params.messageId,
        params.checkLabelId,
        params.signoutBtnLabelId,
      ]);

    const result = await Services.prompt.asyncConfirmEx(
      window.browsingContext,
      Services.prompt.MODAL_TYPE_INTERNAL_WINDOW,
      title,
      message,
      params.flags,
      signoutBtnLabel,
      null,
      null,
      checkLabel,
      true
    );

    if (
      !this._handleSignoutPromptResult(
        result.get("buttonNumClicked"),
        result.get("checked")
      )
    ) {
      return;
    }

    await this.initiateShutdown();
  },

  async initiateShutdown() {
    // TODO: Bug 2001029 - Assert or force-enable session restore?

    try {
      await lazy.ConsoleClient.signoutUser();
    } catch (e) {
      console.error(`Unable to signout the user: ${e}`);
    } finally {
      Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
    }
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
