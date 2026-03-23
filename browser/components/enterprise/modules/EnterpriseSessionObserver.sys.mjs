/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient: "resource:///modules/enterprise/ConsoleClient.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return console.createInstance({
    prefix: "EnterpriseSessionObserver",
    maxLogLevelPref: "enterprise.loglevel",
  });
});

const TOPICS = ["os-session-end", "os-user-switch", "screen-locked"];

export const EnterpriseSessionObserver = {
  SIGNOUT_ON_USER_SWITCH_PREF: "enterprise.signoutOnUserSwitch",
  SIGNOUT_ON_SCREEN_LOCK_PREF: "enterprise.signoutOnScreenLock",

  _initialized: false,
  _signingOut: false,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    for (const topic of TOPICS) {
      Services.obs.addObserver(this, topic);
    }
  },

  uninit() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;
    for (const topic of TOPICS) {
      try {
        Services.obs.removeObserver(this, topic);
      } catch (e) {
        lazy.log.debug(`Failed to remove observer for ${topic}`, e);
      }
    }
  },

  observe(_subject, topic, _data) {
    switch (topic) {
      case "os-session-end":
        this._handleSessionEnd();
        break;
      case "os-user-switch":
        this._handleUserSwitch();
        break;
      case "screen-locked":
        this._handleScreenLock();
        break;
    }
  },

  _SESSION_END_TIMEOUT_MS: 2000,

  _handleSessionEnd() {
    if (this._signingOut) {
      return;
    }
    this._signingOut = true;
    lazy.log.debug("OS session end detected, signing out");

    // On Windows, WM_ENDSESSION is synchronous and the process will be killed
    // shortly after returning. Spin the Gecko event loop briefly to give the
    // server-side POST a chance to complete before the process is torn down.
    // This is Windows-specific: on macOS and Linux the OS provides async
    // shutdown hooks that don't require manual event loop pumping.
    if (Services.appinfo.OS === "WINNT") {
      let finished = false;
      const deadline = Date.now() + this._SESSION_END_TIMEOUT_MS;

      Promise.race([
        lazy.ConsoleClient._post(lazy.ConsoleClient._paths.SIGNOUT),
        new Promise((_resolve, reject) =>
          lazy.setTimeout(
            () => reject(new Error("Server signout timed out")),
            this._SESSION_END_TIMEOUT_MS
          )
        ),
      ])
        .catch(e => {
          lazy.log.warn("Server-side signout failed during session end", e);
        })
        .finally(() => {
          finished = true;
        });

      try {
        Services.tm.spinEventLoopUntil(
          "EnterpriseSessionObserver:os-session-end",
          () => finished || Date.now() >= deadline
        );
      } catch (e) {
        lazy.log.warn("Event loop spin failed during session end", e);
      }
    }

    lazy.ConsoleClient.clearTokenData();
    Services.felt.makeBackgroundProcess(true);
    Services.felt.performSignout();

    // On Windows WM_ENDSESSION, DoImmediateExit() runs after we return
    // so this is a no-op. On macOS/Linux (and in tests), this ensures
    // the browser actually quits.
    Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
  },

  _handleUserSwitch() {
    if (!Services.prefs.getBoolPref(this.SIGNOUT_ON_USER_SWITCH_PREF, true)) {
      return;
    }
    lazy.log.debug("OS user switch detected, signing out");
    this._performOsInitiatedSignout();
  },

  _handleScreenLock() {
    if (!Services.prefs.getBoolPref(this.SIGNOUT_ON_SCREEN_LOCK_PREF, false)) {
      return;
    }
    lazy.log.debug("Screen lock detected, signing out");
    this._performOsInitiatedSignout();
  },

  _SERVER_SIGNOUT_TIMEOUT_MS: 5000,

  async _performOsInitiatedSignout() {
    if (this._signingOut) {
      return;
    }
    this._signingOut = true;
    // Best-effort server-side revocation BEFORE clearing tokens.
    // ConsoleClient._post() calls getAccessToken() internally, which needs
    // the access token to still be present. Use a timeout to avoid stalling
    // if the network is unreachable.
    try {
      await Promise.race([
        lazy.ConsoleClient._post(lazy.ConsoleClient._paths.SIGNOUT),
        new Promise((_resolve, reject) =>
          lazy.setTimeout(
            () => reject(new Error("Server signout timed out")),
            this._SERVER_SIGNOUT_TIMEOUT_MS
          )
        ),
      ]);
    } catch (e) {
      lazy.log.warn(
        "Server-side signout failed, continuing with local cleanup",
        e
      );
    }

    lazy.ConsoleClient.clearTokenData();

    Services.felt.makeBackgroundProcess(true);
    Services.felt.performSignout();

    Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
  },
};
