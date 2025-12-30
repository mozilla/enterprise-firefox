/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "localization", () => {
  return new Localization([
    "browser/enterprise/enterprise.ftl",
    "branding/brand.ftl",
  ]);
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

const PROMPT_ON_SIGNOUT_PREF = "enterprise.promptOnSignout";

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
    if (!this._isInitialized) {
      lazy.log.debug("Initializing...");
      await this.initUser();
      this._isInitialized = true;
    }
    this.updateBadge(window);
    this.restrictEnterpriseView(window);
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

  /**
   * Updates the user icon
   *
   * @param {Window} window chrome window
   */
  updateBadge(window) {
    const userIcon = window.document.querySelector("#enterprise-user-icon");

    if (!this._signedInUser) {
      // Hide user icon from enterprise badge until we have user information
      userIcon.hidden = true;
      console.warn(
        "Unable to update user icon in badge without user information"
      );
      return;
    }
    userIcon.style.setProperty(
      "list-style-image",
      `url("${this._signedInUser.pictureUrl}")`
    );
  },

  openPanel(element, event) {
    const win = element.ownerGlobal;
    win.PanelUI.showSubView("panelUI-enterprise", element, event);
    const document = element.ownerDocument;
    const learnMoreLink = document.getElementById("enterprise-learn-more-link");

    if (!learnMoreLink.href) {
      const uri = lazy.ConsoleClient.learnMoreURI;
      learnMoreLink.setAttribute("href", uri);

      learnMoreLink.addEventListener("click", e => {
        let where = lazy.BrowserUtils.whereToOpenLink(e, false, false);
        if (where == "current") {
          where = "tab";
        }
        win.openTrustedLinkIn(uri, where);
        e.preventDefault();

        const panel = document
          .getElementById("panelUI-enterprise")
          .closest("panel");
        win.PanelMultiView.hidePopup(panel);
      });
    }

    const email = document.querySelector(".panelUI-enterprise__email");
    if (!this._signedInUser) {
      email.hidden = true;
      document.querySelector("#PanelUI-enterprise-separator").hidden = true;
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

  async onSignOut(window) {
    const shouldInformOnSignout = Services.prefs.getBoolPref(
      PROMPT_ON_SIGNOUT_PREF,
      true
    );

    if (!shouldInformOnSignout) {
      await this.initiateShutdown();
      return;
    }

    const [title, message, checkLabel, signoutBtnLabel] =
      await lazy.localization.formatValues([
        { id: "enterprise-signout-prompt-title" },
        { id: "enterprise-signout-prompt-message" },
        { id: "enterprise-signout-prompt-checkbox-label" },
        { id: "enterprise-signout-prompt-primary-btn-label" },
      ]);

    const flags =
      Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_0 +
      Services.prompt.BUTTON_TITLE_CANCEL * Services.prompt.BUTTON_POS_1 +
      Services.prompt.BUTTON_POS_0_DEFAULT;

    // buttonPressed will be 0 for Signout and 1 for Cancel
    const result = await Services.prompt.asyncConfirmEx(
      window.browsingContext,
      Services.prompt.MODAL_TYPE_INTERNAL_WINDOW,
      title,
      message,
      flags,
      signoutBtnLabel,
      null,
      null,
      checkLabel,
      true // checkbox checked
    );

    if (result.get("buttonNumClicked") === 1) {
      // User canceled signout. Also ignore any checkbox toggling.
      return;
    }

    if (!result.get("checked")) {
      // User unchecked the option to be prompted before signout
      Services.prefs.setBoolPref(PROMPT_ON_SIGNOUT_PREF, result.get("checked"));
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
};
