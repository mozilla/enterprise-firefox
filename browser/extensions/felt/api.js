/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* globals ExtensionAPI, Services, XPCOMUtils */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  UpdateListener: "resource://gre/modules/UpdateListener.sys.mjs",
  FELT_OPEN_WINDOW_DISPOSITION: "resource:///modules/FeltURLHandler.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  FeltStorage: "resource:///modules/FeltStorage.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ConsoleClient: "resource:///modules/enterprise/ConsoleClient.sys.mjs",
  isBlockingShutdown: "resource:///modules/enterprise/EnterpriseCommon.sys.mjs",
  shouldNotCloseWindow:
    "resource:///modules/enterprise/EnterpriseCommon.sys.mjs",
  createEnterpriseLogger:
    "resource:///modules/enterprise/EnterpriseCommon.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("Felt");
});

this.felt = class extends ExtensionAPI {
  FELT_PROCESS_ACTOR = "FeltProcess";
  FELT_WINDOW_ACTOR = "FeltWindow";

  registerChrome() {
    let aomStartup = Cc[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(Ci.amIAddonManagerStartup);

    const manifestURI = Services.io.newURI(
      "manifest.json",
      null,
      this.extension.rootURI
    );

    this.chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "felt", "content/"],
    ]);
  }
  async registerActors() {
    const { ConsoleClient } = ChromeUtils.importESModule(
      "resource:///modules/enterprise/ConsoleClient.sys.mjs"
    );
    const matches = [await ConsoleClient.ssoCallbackUriMatchPattern];
    ChromeUtils.registerWindowActor(this.FELT_WINDOW_ACTOR, {
      parent: {
        esModuleURI: "chrome://felt/content/FeltWindowParent.sys.mjs",
      },
      child: {
        esModuleURI: "chrome://felt/content/FeltWindowChild.sys.mjs",
        events: {
          DOMContentLoaded: {},
          load: {},
        },
      },
      allFrames: true,
      matches,
    });

    // We use a much simpler version of the context menu so replace the default actor with our own.
    ChromeUtils.unregisterWindowActor("ContextMenu");
    ChromeUtils.registerWindowActor("ContextMenu", {
      parent: {
        esModuleURI: "chrome://felt/content/ContextMenuParent.sys.mjs",
      },
      child: {
        esModuleURI: "chrome://felt/content/ContextMenuChild.sys.mjs",
        events: {
          contextmenu: { mozSystemGroup: true },
        },
      },
      allFrames: true,
    });

    ChromeUtils.registerProcessActor(this.FELT_PROCESS_ACTOR, {
      parent: {
        esModuleURI: "chrome://felt/content/FeltProcessParent.sys.mjs",
      },
    });
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
        lazy.log.error(
          "FeltExtension: No browser window available to open URL"
        );
        return;
      }

      try {
        win.openTrustedLinkIn(url, "tab");
        win.focus();
      } catch (err) {
        lazy.log.error("FeltExtension: Failed to open forwarded URL", url, err);
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
        lazy.log.error("FeltExtension: Failed to open forwarded window", err);
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

  _feltMessageListeners = [
    "FeltParent:FirefoxNormalExit",
    "FeltParent:FirefoxRestartUpdateExit",
    "FeltParent:FirefoxLogoutExit",
    "FeltParent:FirefoxAbnormalExit",
    "FeltParent:FirefoxLaunchFailure",
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

  async onStartup() {
    if (Services.felt.isFeltUI()) {
      // Disable QoS thread priority demotion: background content processes get
      // their main thread demoted to low-priority QoS, which can starve the
      // SSO callback's DOMContentLoaded event and prevent token extraction.
      Services.prefs.setBoolPref("threads.use_low_power.enabled", false);
      this.registerChrome();
      await this.registerActors();
      await lazy.FeltStorage.init();
      this.showWindow();
      this.addFeltMessageListeners();
    } else if (Services.felt.isFeltBrowser()) {
      // In the real Firefox, register observer to handle URLs
      Services.obs.addObserver(this.urlObserver, "felt-open-url");
      Services.obs.addObserver(this.updateObserver, "felt-update-ready");
      // Notify that extension is ready to receive URLs
      try {
        Services.felt.sendExtensionReady();
      } catch (e) {
        lazy.log.error("FeltExtension: Failed to send extension ready:", e);
      }
    }
  }

  receiveMessage(message) {
    lazy.log.debug(`FeltExtension: ${message.name} handling ...`);
    switch (message.name) {
      case "FeltParent:FirefoxNormalExit": {
        Services.ppmm.removeMessageListener(
          "FeltParent:FirefoxNormalExit",
          this
        );

        lazy.ConsoleClient.performServerSignout()
          .catch(err => {
            console.error(
              `FeltExtension: Failed to post signout on exit: ${err}`
            );
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
        lazy.log.debug(`FeltExtension: makeBackgroundProcess? ${success}`);
        this.showWindow("felt-browser-error-multiple-crashes");
        break;
      }

      case "FeltParent:FirefoxLaunchFailure": {
        Services.felt.makeBackgroundProcess(false);
        this.resetToLoginPage("felt-browser-error-launch-failure");
        break;
      }

      case "FeltParent:FirefoxLogoutExit": {
        Services.felt.makeBackgroundProcess(false);
        switch (message.data?.reason) {
          case "tokenRefreshFailed":
            // TODO: this is not 100% in line with the figma document around
            // informal messages on this screen.
            // We do not currently distinguish between normal session termination
            // because of a timeout or a forced signout triggered from the admin
            // console.
            this.showWindow("felt-browser-error-token-refresh-failed");
            break;
          case "logout":
          default:
            this.showWindow();
            break;
        }
        break;
      }

      case "FeltParent:TransitionFeltToBackground": {
        Services.startup.enterLastWindowClosingSurvivalArea();
        this.closeWindow();
        const success = Services.felt.makeBackgroundProcess(true);
        lazy.log.debug(`FeltExtension: makeBackgroundProcess? ${success}`);
        break;
      }

      case "FeltParent:ForceFeltFocus": {
        lazy.log.debug(
          `FeltExtension: forcing window focus: this._win=${this._win}`
        );
        if (this._win) {
          this._win.focus();
        }
        break;
      }

      default:
        lazy.log.debug(`FeltExtension: ${message.name} NOT HANDLED`);
        break;
    }
  }

  windowObserver(subject, topic) {
    lazy.log.debug(`FeltExtension: topic=${topic}`);
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
    lazy.log.debug(`FeltExtension: closeWindow: this._win=${this._win}`);
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

  resetToLoginPage(errorMessage = "") {
    if (!this._win) {
      this.showWindow(errorMessage);
      return;
    }
    this._win.resetToLoginPage(errorMessage);
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

  onShutdown(isAppShutdown) {
    lazy.log.debug(`FeltExtension: onShutdown: ${isAppShutdown}`);

    if (isAppShutdown) {
      return;
    }

    if (Services.felt.isFeltBrowser()) {
      Services.obs.removeObserver(this.urlObserver, "felt-open-url");
      Services.obs.removeObserver(this.updateObserver, "felt-update-ready");
    }

    if (Services.felt.isFeltUI()) {
      this.removeFeltMessageListeners();
    }

    if (this.chromeHandle) {
      this.chromeHandle.destruct();
      this.chromeHandle = null;
    }

    if (Services.felt.isFeltUI()) {
      ChromeUtils.unregisterWindowActor(this.FELT_WINDOW_ACTOR);
      ChromeUtils.unregisterProcessActor(this.FELT_PROCESS_ACTOR);
      lazy.FeltStorage.uninit();
    }
  }
};
