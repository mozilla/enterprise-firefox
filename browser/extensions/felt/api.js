/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* globals ExtensionAPI, Services, XPCOMUtils */

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
      "chrome://felt/content/ConsoleClient.sys.mjs"
    );
    const matches = [ConsoleClient.ssoCallbackUri];
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

    ChromeUtils.registerProcessActor(this.FELT_PROCESS_ACTOR, {
      parent: {
        esModuleURI: "chrome://felt/content/FeltProcessParent.sys.mjs",
      },
    });
  }

  onStartup() {
    // In tests if we close too early we lose the browser context
    if (Services.prefs.getBoolPref("browser.felt.is_testing", false)) {
      this.windowCloseMessage = "FeltParent:FirefoxStarted";
    } else {
      this.windowCloseMessage = "FeltParent:FirefoxStarting";
    }

    if (Services.felt.isFeltUI()) {
      this.registerChrome();
      this.registerActors();
      this.showWindow();
      Services.ppmm.addMessageListener("FeltParent:FirefoxNormalExit", this);
      Services.ppmm.addMessageListener("FeltParent:FirefoxAbnormalExit", this);
      Services.ppmm.addMessageListener("FeltParent:FirefoxStarting", this);
      Services.ppmm.addMessageListener("FeltParent:FirefoxStarted", this);
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

      case "FeltParent:FirefoxAbnormalExit":
        Services.ppmm.removeMessageListener(
          "FeltParent:FirefoxAbnormalExit",
          this
        );
        // TODO: What should we do, restart Firefox?
        break;

      case this.windowCloseMessage: {
        Services.startup.enterLastWindowClosingSurvivalArea();
        Services.ww.unregisterNotification(this.windowObserver);
        this._win.close();
        const success = Services.felt.makeBackgroundProcess();
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
      Services.ww.unregisterNotification(this.windowObserver);
      Services.startup.quit(
        Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eConsiderQuit
      );
    }
  }

  showWindow() {
    // Height and width are for now set to fit the sso.mozilla.com without the need to resize the window
    let flags = "chrome,centerscreen,titlebar,resizable,width=727,height=744";
    this._win = Services.ww.openWindow(
      null,
      "chrome://felt/content/felt.xhtml",
      "_blank",
      flags,
      null
    );

    Services.ww.registerNotification(this.windowObserver);

    // The window will send notifyObservers() itself. This is required
    // to make sure things are starting properly, including registration
    // of browsers with Marionette
  }

  onShutdown(isAppShutdown) {
    console.debug(`FeltExtension: onShutdown: ${isAppShutdown}`);

    if (isAppShutdown) {
      return;
    }

    Services.ppmm.removeMessageListener("FeltChild:Loaded", this);

    this.chromeHandle.destruct();
    this.chromeHandle = null;

    ChromeUtils.unregisterWindowActor(this.FELT_WINDOW_ACTOR);
    ChromeUtils.unregisterProcessActor(this.FELT_PROCESS_ACTOR);
  }
};
