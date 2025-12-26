/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* globals ExtensionAPI, Services, XPCOMUtils */

const lazy = {};
const FELT_OPEN_DISPOSITION_DEFAULT = 0;
const FELT_OPEN_DISPOSITION_NEW_WINDOW = 1;
const FELT_OPEN_DISPOSITION_NEW_PRIVATE_WINDOW = 2;

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  FeltStorage: "resource:///modules/FeltStorage.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
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
  registerActors() {
    const { ConsoleClient } = ChromeUtils.importESModule(
      "resource:///modules/enterprise/ConsoleClient.sys.mjs"
    );
    const matches = [ConsoleClient.ssoCallbackUriMatchPattern];
    ChromeUtils.registerWindowActor(this.FELT_WINDOW_ACTOR, {
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
        disposition === FELT_OPEN_DISPOSITION_NEW_WINDOW ||
        disposition === FELT_OPEN_DISPOSITION_NEW_PRIVATE_WINDOW
      ) {
        let wantsPrivate =
          disposition === FELT_OPEN_DISPOSITION_NEW_PRIVATE_WINDOW;
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
        console.error("FeltExtension: No browser window available to open URL");
        return;
      }

      try {
        win.openTrustedLinkIn(url, "tab");
      } catch (err) {
        console.error("FeltExtension: Failed to open forwarded URL", url, err);
      }
    },

    _parseOpenURLData(data) {
      let parsed = JSON.parse(data);
      return {
        url: parsed.url ?? "",
        disposition: parsed.disposition ?? FELT_OPEN_DISPOSITION_DEFAULT,
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
        console.error("FeltExtension: Failed to open forwarded window", err);
      }
    },
  };

  async onStartup() {
    if (Services.felt.isFeltUI()) {
      Services.prefs.setBoolPref("identity.fxaccounts.enabled", false);
      this.registerChrome();
      this.registerActors();
      await lazy.FeltStorage.init();
      this.showWindow();
      Services.ppmm.addMessageListener("FeltParent:FirefoxNormalExit", this);
      Services.ppmm.addMessageListener("FeltParent:FirefoxLogoutExit", this);
      Services.ppmm.addMessageListener("FeltParent:FirefoxAbnormalExit", this);
      Services.ppmm.addMessageListener("FeltParent:FirefoxStarting", this);
    } else if (Services.felt.isFeltBrowser()) {
      // In the real Firefox, register observer to handle URLs
      Services.obs.addObserver(this.urlObserver, "felt-open-url");
      // Notify that extension is ready to receive URLs
      try {
        Services.felt.sendExtensionReady();
      } catch (e) {
        console.error("FeltExtension: Failed to send extension ready:", e);
      }
    }
  }

  receiveMessage(message) {
    console.debug(`FeltExtension: ${message.name} handling ...`);
    switch (message.name) {
      case "FeltParent:FirefoxNormalExit":
        Services.ppmm.removeMessageListener(
          "FeltParent:FirefoxNormalExit",
          this
        );
        Services.startup.quit(
          Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eConsiderQuit
        );
        break;

      case "FeltParent:FirefoxAbnormalExit": {
        const success = Services.felt.makeBackgroundProcess(false);
        console.debug(`FeltExtension: makeBackgroundProcess? ${success}`);
        this.showWindow("felt-browser-error-multiple-crashes");
        break;
      }

      case "FeltParent:FirefoxLogoutExit": {
        const success = Services.felt.makeBackgroundProcess(false);
        console.debug(`FeltExtension: makeBackgroundProcess? ${success}`);
        this.showWindow();
        break;
      }

      case "FeltParent:FirefoxStarting": {
        Services.startup.enterLastWindowClosingSurvivalArea();
        Services.ww.unregisterNotification(this._winObserver);
        this._win.close();
        const success = Services.felt.makeBackgroundProcess(true);
        console.debug(`FeltExtension: makeBackgroundProcess? ${success}`);
        break;
      }

      default:
        console.debug(`FeltExtension: ${message.name} NOT HANDLED`);
        break;
    }
  }

  windowObserver(subject, topic) {
    console.debug(`FeltExtension: topic=${topic}`);
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
    console.debug(`FeltExtension: onShutdown: ${isAppShutdown}`);

    if (isAppShutdown) {
      return;
    }

    if (Services.felt.isFeltBrowser()) {
      Services.obs.removeObserver(this.urlObserver, "felt-open-url");
    }

    Services.ppmm.removeMessageListener("FeltChild:Loaded", this);

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
