/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* globals ExtensionAPI, Services, XPCOMUtils */

let JSWINDOWACTORS = {};

JSWINDOWACTORS.Felt = {
  parent: {
    esModuleURI: "chrome://felt/content/FeltParent.sys.mjs",
  },

  child: {
    esModuleURI: "chrome://felt/content/FeltChild.sys.mjs",
    events: {
      DOMContentLoaded: {},
      load: {},
    },
  },

  allFrames: true,
  matches: [""],

  onAddActor(register, unregister) {
    let isRegistered = false;

    const maybeRegister = () => {
      const isEnabled = Services.prefs.getBoolPref(
        "browser.felt.enabled",
        false
      );
      if (isEnabled) {
        JSWINDOWACTORS.Felt.matches = Services.prefs
          .getStringPref("browser.felt.matches")
          .split(",");
        if (!isRegistered) {
          register();
          isRegistered = true;
        }
      } else if (isRegistered) {
        unregister();
        isRegistered = false;
      }
    };

    Services.prefs.addObserver("browser.felt.enabled", maybeRegister);
    maybeRegister();
  },
};

let ActorManagerParent = {
  _addActors(actors, kind) {
    let register, unregister;
    switch (kind) {
      case "JSWindowActor":
        register = ChromeUtils.registerWindowActor;
        unregister = ChromeUtils.unregisterWindowActor;
        break;
      default:
        throw new Error("Invalid JSActor kind " + kind);
    }
    for (let [actorName, actor] of Object.entries(actors)) {
      // The actor defines its own register/unregister logic.
      if (actor.onAddActor) {
        actor.onAddActor(
          () => register(actorName, actor),
          () => unregister(actorName, actor)
        );
        continue;
      }

      // If enablePreference is set, only register the actor while the
      // preference is set to true.
      if (actor.enablePreference) {
        Services.prefs.addObserver(actor.enablePreference, () => {
          const isEnabled = Services.prefs.getBoolPref(
            actor.enablePreference,
            false
          );
          if (isEnabled) {
            register(actorName, actor);
          } else {
            unregister(actorName, actor);
          }
          if (actor.onPreferenceChanged) {
            actor.onPreferenceChanged(isEnabled);
          }
        });

        if (!Services.prefs.getBoolPref(actor.enablePreference, false)) {
          continue;
        }
      }

      register(actorName, actor);
    }
  },

  addJSWindowActors(actors) {
    this._addActors(actors, "JSWindowActor");
  },
};

this.felt = class extends ExtensionAPI {
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

  connectConsole() {
    if (this.feltXPCOM === undefined) {
      console.debug(`FELT: No XPCOM!`);
      return;
    }

    this.feltXPCOM.setPrefsForFelt();
  }

  onStartup() {
    this.feltXPCOM = Cc["@mozilla.org/toolkit/library/felt;1"].getService(
      Ci.nsIFelt
    );

    if (this.feltXPCOM.isFeltUI()) {
      this.feltXPCOM.setConsoleAddr("http://localhost:8000");
      this.connectConsole();
      this.registerChrome();
      ActorManagerParent.addJSWindowActors(JSWINDOWACTORS);
      this.showWindow();
      Services.ppmm.addMessageListener("FeltChild:Loaded", this);
      Services.ppmm.addMessageListener("FeltParent:FirefoxNormalExit", this);
      Services.ppmm.addMessageListener("FeltParent:FirefoxAbnormalExit", this);
      Services.ppmm.addMessageListener("FeltParent:FirefoxStarted", this);
    }
  }

  receiveMessage(message) {
    console.debug(`FeltExtension: ${message.name} handling ...`);
    switch (message.name) {
      case "FeltChild:Loaded":
        Services.ppmm.removeMessageListener("FeltChild:Loaded", this);
        const redirect_after_sso = Services.prefs.getStringPref("browser.felt.redirect_after_sso");
        Services.ppmm.broadcastAsyncMessage("FeltMain:RedirectURL", redirect_after_sso);
        break;

      case "FeltParent:FirefoxNormalExit":
        Services.ppmm.removeMessageListener("FeltParent:FirefoxNormalExit", this);
	Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eConsiderQuit);
        break;

      case "FeltParent:FirefoxAbnormalExit":
        Services.ppmm.removeMessageListener("FeltParent:FirefoxAbnormalExit", this);
        // TODO: What should we do, restart Firefox?
        break;

      case "FeltParent:FirefoxStarted":
        this._win.minimize();
        break;

      default:
        console.debug(`FeltExtension: ${message.name} NOT HANDLED`);
        break;
    }
  }

  showWindow() {
    let flags = "chrome,centerscreen,titlebar";
    this._win = Services.ww.openWindow(
      null,
      "chrome://felt/content/feltui.xhtml",
      "_blank",
      flags,
      null
    );

    const windowObserver = (subject, topic) => {
      if (this._win === subject) {
        Services.ww.unregisterNotification(windowObserver);
	Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eConsiderQuit);
      }
    };

    Services.ww.registerNotification(windowObserver);

    // Required to make sure that things are starting properly
    Services.obs.notifyObservers(this._win, "browser-delayed-startup-finished");
    Services.obs.notifyObservers(this._win, "extensions-late-startup");
  }

  onShutdown(isAppShutdown) {
    console.debug(`FeltExtension: onShutdown: ${isAppShutdown}`);

    if (isAppShutdown) {
      return;
    }

    Services.ppmm.removeMessageListener("FeltChild:Loaded", this);

    this.chromeHandle.destruct();
    this.chromeHandle = null;

    ChromeUtils.unregisterWindowActor("FELT");
  }
};
