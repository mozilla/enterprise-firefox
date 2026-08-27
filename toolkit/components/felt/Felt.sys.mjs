/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  UpdateListener: "resource://gre/modules/UpdateListener.sys.mjs",
  FeltStorage: "resource://gre/modules/enterprise/FeltStorage.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  isBlockingShutdown:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  isBuildAppBrowser:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  shouldNotCloseWindow:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  WebAuthnPromptHelper:
    "moz-src:///toolkit/modules/WebAuthnPromptHelper.sys.mjs",
});

if (lazy.isBuildAppBrowser()) {
  ChromeUtils.defineESModuleGetters(lazy, {
    // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
    FELT_OPEN_WINDOW_DISPOSITION: "resource:///modules/FeltURLHandler.sys.mjs",
    // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
    BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  });
}

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("Felt");
});

/**
 * Felt is an XPCOM component that manages the lifecycle of the
 * Firefox Enterprise Launcher Tool (FELT) UI and its interaction with the
 * regular Firefox browser process.
 *
 * It is instantiated as a singleton via profile-after-change
 * and remains alive (as an nsIObserver) until xpcom-shutdown.
 *
 * Responsibilities include:
 *  - Showing and closing the FELT chrome window (showWindow/closeWindow).
 *  - Forwarding URLs opened by FELT to a normal browser window, or opening
 *    a new (possibly private) browser window, via urlObserver.
 *  - Listening for and reacting to update-ready notifications
 *    (updateObserver) and WebAuthn prompts (webauthnObserver).
 *  - Handling process-level messages sent from the FELT child process
 *    (FeltParent:* messages) such as normal/abnormal exits, restarts for
 *    updates, logout, transitioning to background, and forcing focus.
 *  - Ensuring the application does not exit prematurely while FELT is
 *    starting up or needs to remain alive, using
 *    enter/exitLastWindowClosingSurvivalArea.
 */
export class Felt {
  // XPCOM identity
  static classID = Components.ID("{4a73d4d4-09fd-4f68-8c31-a6b39bfb36b7}");
  static contractID = "@mozilla.org/felt;1";
  static classDescription = "Felt";

  // QI — implement nsISupports + nsIObserver
  QueryInterface = ChromeUtils.generateQI(["nsIObserver"]);

  constructor() {
    if (Services.felt?.isFeltUI()) {
      // Felt UI XPCOM is triggered by profile-after-change, make sure to block
      // closing until startup has been executed. Once FELT UI's window will
      // open, its 'domwindowopened' handler will balance this call with
      // a call to exitLastWindowClosingSurvivalArea().
      Services.startup.enterLastWindowClosingSurvivalArea();
    }
  }

  // nsIObserver
  observe(_subject, topic, _data) {
    switch (topic) {
      case "profile-after-change":
        Services.obs.addObserver(this, "xpcom-shutdown");
        this.#init().catch(e => lazy.log.error("Felt init failed", e));
        break;
      case "xpcom-shutdown":
        Services.obs.removeObserver(this, "xpcom-shutdown");
        this.#handleShutdown();
    }
  }

  urlObserver = {
    _sessionStoreRestored: false,

    observe(aSubject, aTopic, aData) {
      if (aTopic === "felt-open-url" && aData) {
        this._handleFeltExternalUrl(aData);
      }
    },

    async _handleFeltExternalUrl(data) {
      let { url, disposition } = this._parseOpenURLData(data);
      if (
        disposition === lazy.FELT_OPEN_WINDOW_DISPOSITION.NEW_WINDOW ||
        disposition === lazy.FELT_OPEN_WINDOW_DISPOSITION.NEW_PRIVATE_WINDOW
      ) {
        let wantsPrivate =
          disposition === lazy.FELT_OPEN_WINDOW_DISPOSITION.NEW_PRIVATE_WINDOW;
        this._openFeltWindow(url, wantsPrivate);
        return;
      }
      let win = lazy.BrowserWindowTracker.getTopWindow({
        private: false,
      });

      // If no window and sessionstore hasn't restored yet, wait for it
      if (!win && !this._sessionStoreRestored) {
        const self = this;
        await new Promise(resolve => {
          const observer = {
            observe(subject, topic) {
              if (topic === "sessionstore-windows-restored") {
                Services.obs.removeObserver(
                  observer,
                  "sessionstore-windows-restored"
                );
                self._sessionStoreRestored = true;
                resolve();
              }
            },
          };
          Services.obs.addObserver(observer, "sessionstore-windows-restored");
        });

        // Try again after startup completes
        win = lazy.BrowserWindowTracker.getTopWindow({
          private: false,
        });
      }

      if (!win) {
        lazy.log.error("No browser window available to open URL");
        return;
      }

      try {
        win.openTrustedLinkIn(url, "tab");
        win.focus();
      } catch (err) {
        lazy.log.error("Failed to open forwarded URL", url, err);
      }
    },

    _parseOpenURLData(data) {
      let parsed = JSON.parse(data);
      return {
        url: parsed.url ?? "",
        disposition:
          parsed.disposition ?? lazy.FELT_OPEN_WINDOW_DISPOSITION.DEFAULT,
      };
    },

    _openFeltWindow(url, wantsPrivate) {
      if (wantsPrivate && !lazy.PrivateBrowsingUtils.enabled) {
        wantsPrivate = false;
        url = "about:privatebrowsing";
      }

      try {
        let args = null;
        if (url) {
          args = Cc["@mozilla.org/supports-string;1"].createInstance(
            Ci.nsISupportsString
          );
          args.data = url;
        }
        lazy.BrowserWindowTracker.openWindow({
          private: wantsPrivate,
          args,
        });
      } catch (err) {
        lazy.log.error("Failed to open forwarded window", err);
      }
    },
  };

  updateObserver = {
    observe(aSubject, aTopic, _aData) {
      if (aTopic === "felt-update-ready") {
        // Directly call showUpdateNotification to bypass other instance update
        // checking
        lazy.UpdateListener.showUpdateNotification(
          "restart",
          () => lazy.UpdateListener.requestRestart(),
          true,
          { dismissed: true }
        );
      }
    },
  };

  webauthnObserver = {
    observe(aSubject, aTopic, aData) {
      if (aTopic === "webauthn-prompt") {
        lazy.WebAuthnPromptHelper.observe(aSubject, aTopic, aData);
      }
    },
  };

  _feltMessageListeners = [
    "FeltParent:FirefoxNormalExit",
    "FeltParent:FirefoxRestartUpdateExit",
    "FeltParent:FirefoxLogoutExit",
    "FeltParent:FirefoxAbnormalExit",
    "FeltParent:FirefoxLaunchFailure",
    "FeltParent:FirefoxSessionInterrupted",
    "FeltParent:TransitionFeltToBackground",
    "FeltParent:ForceFeltFocus",
  ];

  addFeltMessageListeners() {
    this._feltMessageListeners.forEach(messageListener =>
      Services.ppmm.addMessageListener(messageListener, this)
    );
  }

  removeFeltMessageListeners() {
    this._feltMessageListeners.forEach(messageListener =>
      Services.ppmm.removeMessageListener(messageListener, this)
    );
  }

  async #init() {
    if (Services.felt.isFeltUI()) {
      // Disable QoS thread priority demotion: background content processes get
      // their main thread demoted to low-priority QoS, which can starve the
      // SSO callback's DOMContentLoaded event and prevent token extraction.
      Services.prefs.setBoolPref("threads.use_low_power.enabled", false);
      await lazy.FeltStorage.init();
      this.showWindow();
      this.addFeltMessageListeners();
      if (!lazy.isBuildAppBrowser()) {
        Services.obs.addObserver(this.webauthnObserver, "webauthn-prompt");
      }
    } else if (Services.felt.isFeltBrowser()) {
      // In the real Firefox, register observer to handle URLs
      if (lazy.isBuildAppBrowser()) {
        Services.obs.addObserver(this.urlObserver, "felt-open-url");
      }
      Services.obs.addObserver(this.updateObserver, "felt-update-ready");
      // Notify that FELT is ready to receive URLs
      try {
        Services.felt.sendFeltReady();
      } catch (e) {
        lazy.log.error("Failed to send Felt ready:", e);
      }
    }
  }

  receiveMessage(message) {
    lazy.log.debug(`${message.name} handling ...`);
    switch (message.name) {
      case "FeltParent:FirefoxNormalExit": {
        Services.ppmm.removeMessageListener(
          "FeltParent:FirefoxNormalExit",
          this
        );

        lazy.ConsoleClient.performServerSignout()
          .catch(err => {
            console.error(`Failed to post signout on exit: ${err}`);
          })
          .finally(() => {
            Services.felt.clearTokens();
            // This is only useful for testing purpose when we need to exit the
            // browser cleanly but need to keep felt alive for some processing after
            if (!lazy.isBlockingShutdown()) {
              Services.startup.quit(
                Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eConsiderQuit
              );
            } else if (!this._win) {
              Services.felt.makeBackgroundProcess(false);
              this.showWindow();
            }
          });
        break;
      }

      case "FeltParent:FirefoxRestartUpdateExit": {
        Services.ppmm.removeMessageListener(
          "FeltParent:FirefoxRestartUpdateExit",
          this
        );
        Services.startup.quit(
          Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart
        );
        break;
      }

      case "FeltParent:FirefoxAbnormalExit": {
        const success = Services.felt.makeBackgroundProcess(false);
        lazy.log.debug(`makeBackgroundProcess? ${success}`);
        this.showWindow("felt-browser-error-multiple-crashes");
        break;
      }

      case "FeltParent:FirefoxLaunchFailure": {
        Services.felt.makeBackgroundProcess(false);
        const errorClassByType = {
          primarySecret: "felt-error-primary-secret",
          sdrTokenUnlockFailed: "felt-error-sdr-token-unlock-failed",
        };
        const errorClass =
          errorClassByType[message.data?.errorType] ??
          "felt-browser-error-launch-failure";
        this.showWindow(errorClass);
        break;
      }

      case "FeltParent:FirefoxLogoutExit": {
        Services.felt.makeBackgroundProcess(false);
        this.showWindow();
        break;
      }

      case "FeltParent:FirefoxSessionInterrupted": {
        Services.felt.makeBackgroundProcess(false);
        switch (message.data?.reason) {
          case "tokenRefreshExpired":
            // TODO: this is not 100% in line with the figma document around
            // informal messages on this screen.
            // We do not currently distinguish between normal session termination
            // because of a timeout or a forced signout triggered from the admin
            // console.
            this.showWindow("felt-browser-error-session-expired");
            break;
          case "networkLoss":
            this.showWindow("felt-browser-error-network-loss");
            break;
          case "tokenRefreshFailed":
          default:
            this.showWindow("felt-browser-error-session-interrupted");
            break;
        }
        break;
      }

      case "FeltParent:TransitionFeltToBackground": {
        // FELT UI has been asked to transition to background, so issue a call
        // to enterLastWindowClosingSurvivalArea() to make sure lack of window
        // will not end up in process exit. This will be balanced by a call to
        // exitLastWindowClosingSurvivalArea() next time the window is opened.
        Services.startup.enterLastWindowClosingSurvivalArea();
        this.closeWindow();
        const success = Services.felt.makeBackgroundProcess(true);
        lazy.log.debug(`makeBackgroundProcess? ${success}`);
        break;
      }

      case "FeltParent:ForceFeltFocus": {
        lazy.log.debug(`forcing window focus: this._win=${this._win}`);
        if (this._win) {
          this._win.focus();
        }
        break;
      }

      default:
        lazy.log.debug(`${message.name} NOT HANDLED`);
        break;
    }
  }

  windowObserver(subject, topic) {
    lazy.log.debug(`topic=${topic}`);
    if (topic === "domwindowopened") {
      Services.startup.exitLastWindowClosingSurvivalArea();
    }

    if (topic === "domwindowclosed" && this._win === subject) {
      Services.ww.unregisterNotification(this._winObserver);
      Services.startup.quit(
        Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eConsiderQuit
      );
    }
  }

  closeWindow() {
    lazy.log.debug(`closeWindow: this._win=${this._win}`);
    if (lazy.shouldNotCloseWindow()) {
      // Some tests needs to run code on FELT while Browser is running, and
      // this requires the window to be kept alive.
      return;
    }
    Services.ww.unregisterNotification(this._winObserver);
    this._win.close();
    this._win = null;
    this._winObserver = null;
  }

  showWindow(errorMessage = "") {
    // Height and width are for now set to fit the sso.mozilla.com without the need to resize the window
    let flags =
      "chrome,private,centerscreen,titlebar,resizable,width=727,height=744";
    const queryString = errorMessage
      ? `?error=${encodeURIComponent(errorMessage)}`
      : "";

    this._win = Services.ww.openWindow(
      null,
      `chrome://felt/content/felt.xhtml${queryString}`,
      "_blank",
      flags,
      null
    );
    this._winObserver = this.windowObserver.bind(this);

    Services.ww.registerNotification(this._winObserver);

    // The window will send notifyObservers() itself. This is required
    // to make sure things are starting properly, including registration
    // of browsers with Marionette
  }

  #handleShutdown() {
    lazy.log.debug(`handleShutdown()`);

    if (Services.felt.isFeltBrowser()) {
      if (lazy.isBuildAppBrowser()) {
        Services.obs.removeObserver(this.urlObserver, "felt-open-url");
      }
      Services.obs.removeObserver(this.updateObserver, "felt-update-ready");
    }

    if (Services.felt.isFeltUI()) {
      this.removeFeltMessageListeners();
      if (!lazy.isBuildAppBrowser()) {
        Services.obs.removeObserver(this.webauthnObserver, "webauthn-prompt");
      }

      lazy.FeltStorage.uninit();
    }
  }
}
