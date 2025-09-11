/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* globals ExtensionAPI, Services, XPCOMUtils */

let JSWINDOWACTORS = {};
JSWINDOWACTORS.FeltWindow = {
  child: {
    esModuleURI: "chrome://felt/content/FeltWindowChild.sys.mjs",
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
        JSWINDOWACTORS.FeltWindow.matches = Services.prefs
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

let JSPROCESSACTORS = {};
JSPROCESSACTORS.FeltProcess = {
  parent: {
    esModuleURI: "chrome://felt/content/FeltProcessParent.sys.mjs",
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
      case "JSProcessActor":
        register = ChromeUtils.registerProcessActor;
        unregister = ChromeUtils.unregisterProcessActor;
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
  addJSProcessActors(actors) {
    this._addActors(actors, "JSProcessActor");
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

  setFeltPrefs() {
    const consoleAddr = Services.prefs.getStringPref("browser.felt.console");
    const prefs = [
      ["browser.felt.sso_url", `${consoleAddr}/sso_url`],
      ["browser.felt.matches", `${consoleAddr}/dashboard`],
      ["browser.felt.redirect_after_sso", `${consoleAddr}/redirect_after_sso`],
      ["browser.felt.enabled", true],
    ];

    prefs.forEach(pref => {
      const name = pref[0];
      const value = pref[1];

      switch (typeof value) {
        case "boolean":
          try {
            Services.prefs.getBoolPref(name);
          } catch {
            Services.prefs.setBoolPref(name, value);
          }
          break;

        case "string":
          try {
            Services.prefs.getStringPref(name);
          } catch {
            Services.prefs.setStringPref(name, value);
          }
          break;

        case "number":
          try {
            Services.prefs.getIntPref(name);
          } catch {
            Services.prefs.setIntPref(name, value);
          }
          break;
      }
    });
  }

  onStartup() {
    this.feltXPCOM = Cc["@mozilla.org/toolkit/library/felt;1"].getService(
      Ci.nsIFelt
    );

    if (this.feltXPCOM.isFeltUI()) {
      this.setFeltPrefs();
      this.registerChrome();
      ActorManagerParent.addJSWindowActors(JSWINDOWACTORS);
      ActorManagerParent.addJSProcessActors(JSPROCESSACTORS);
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
        const redirect_after_sso = Services.prefs.getStringPref(
          "browser.felt.redirect_after_sso"
        );
        Services.ppmm.broadcastAsyncMessage(
          "FeltMain:RedirectURL",
          redirect_after_sso
        );
        break;

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

      case "FeltParent:FirefoxStarted":
        Services.startup.enterLastWindowClosingSurvivalArea();
        Services.ww.unregisterNotification(this.windowObserver);
        this._win.close();
        const success = this.feltXPCOM.makeBackgroundProcess();
        console.debug(`FeltExtension: makeBackgroundProcess? ${success}`);
        break;

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
    let flags = "chrome,centerscreen,titlebar,resizable,width=727,height=772";
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

    ChromeUtils.unregisterWindowActor("Felt");
  }
};
