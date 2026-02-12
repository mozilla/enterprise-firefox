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
  UIState: "resource://services-sync/UIState.sys.mjs",
  Weave: "resource://services-sync/main.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return console.createInstance({
    prefix: "EnterpriseHandler",
    maxLogLevelPref: lazy.EnterpriseCommon.ENTERPRISE_LOGLEVEL_PREF,
  });
});

const PROMPT_ON_SIGNOUT_PREF = "enterprise.promptOnSignout";
const ENTERPRISE_SYNC_ENABLED_PREF = "enterprise.sync.enabledByDefault";

export const EnterpriseHandler = {
  /**
   * @type {{name:string, email:string, pictureUrl:string} | null}
   */
  _signedInUser: null,

  /**
   * Whether the handler is initialized, hence we have retrieved the
   * user information and initialized the sync state.
   */
  _isInitialized: false,

  /**
   * Handles the enterprise state for each new browser window.
   * On first call:
   *    - Make a request to the console to retrieve the user information of the signed in user.
   *    - Configure sync to be enabled or disable (depending on ENTERPRISE_SYNC_ENABLED_PREF)
   * On every call:
   *    - Hide FxA toolbar button and FxA item in app menu (hamburger menu)
   *
   * @param {Window} window chrome window
   */
  async init(window) {
    if (!this._isInitialized) {
      lazy.log.debug("Initializing...");
      await this.initUser();
      this.setupSyncOnceInitialized(window);
    }
    this.updateBadge(window);
    this.restrictEnterpriseView(window);
    this._isInitialized = true;
  },

  /**
   * Check if the FxA state is initialised yet.
   *    - If the state is still undefined, listen for a state update
   *      and set up once the state update occurs.
   *    - If the state is initialized, set up sync immediately.
   *
   * @param {Window} window chrome window
   */
  setupSyncOnceInitialized(window) {
    const status = lazy.UIState.get().status;
    if (status === lazy.UIState.get().STATUS_NOT_CONFIGURED) {
      // State not configured yet.
      lazy.log.debug("Waiting for FxA/Sync status to be updated");
      const syncStateObserver = (_, topic) => {
        switch (topic) {
          case lazy.UIState.ON_UPDATE:
            lazy.log.debug("Sync state has been initialized");
            this.setUpSync(window);
            Services.obs.removeObserver(
              syncStateObserver,
              lazy.UIState.ON_UPDATE
            );
            break;
          default:
            break;
        }
      };
      Services.obs.addObserver(syncStateObserver, lazy.UIState.ON_UPDATE);
      return;
    }
    this.setUpSync();
  },

  /**
   * Align sync state with expected state (ENTERPRISE_SYNC_ENABLED_PREF)
   * by enabling or disabling sync.
   *
   * @param {Window} window chrome window
   */
  setUpSync(window) {
    lazy.log.debug("Handling sync state.");
    const isSyncCurrentlyEnabled = lazy.UIState.get().syncEnabled;
    const isEnableSync = Services.prefs.getBoolPref(
      ENTERPRISE_SYNC_ENABLED_PREF,
      false
    );

    if (isSyncCurrentlyEnabled === isEnableSync) {
      // Nothing to do
      lazy.log.debug(
        `Not changing sync state. It was already ${isSyncCurrentlyEnabled ? "enabled" : "disabled"}`
      );
      return;
    }

    if (isEnableSync) {
      lazy.log.debug(`Connect sync.`);
      lazy.Weave.Service.configure();
    } else {
      lazy.log.debug(`Disconnect sync.`);
      window.gSync.disconnect({
        confirm: false,
        disconnectAccount: false,
      });
    }
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
