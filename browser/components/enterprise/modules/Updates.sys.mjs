/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AppUpdater: "resource://gre/modules/AppUpdater.sys.mjs",
  isUpdatesTesting: "resource:///modules/enterprise/EnterpriseCommon.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const FELT_UPDATE_APPLY_PERCENT_INIT = 10;
const FELT_UPDATE_APPLY_PERCENT_DOWNLOAD_END = 90;
const FELT_UPDATE_APPLY_PERCENT_STAGING_END = 100;

export const Updates = {
  async init(doc, errorReporter) {
    // Make sure that we always refer to the correct document, so we can show
    // back the login UI in any circumstance
    this._document = doc;
    this._errorReporter = errorReporter;

    this.maybeShowUpdateSuccess();

    if (this._initialized) {
      this.displayLoginState();
      return;
    }

    Services.obs.addObserver(this, "xpcom-shutdown");

    // Make sure that observers and listeners for updates feedback and error
    // handling are registered as early as possible to avoid any risk of race
    // condition.
    this.prepareUpdateCheck();

    this._checkingTimeout = null;
    this._receivedStaging = false;
    this.displayUpdateState();

    if (lazy.isUpdatesTesting()) {
      // on Windows at least, during testing, make sure we let time for the UI to show up
      // before we start those actions. For some reason, not doing this ends up
      // in Marionette not starting the test code while the update applies.
      await new Promise((resolve, _) => {
        lazy.setTimeout(resolve, 5000);
      });
    }

    this.forceUpdateCheck();

    this._initialized = true;
  },

  maybeShowUpdateSuccess() {
    const previousBuildID = parseInt(
      Services.prefs.getStringPref(
        "enterprise.felt.previousBuildID",
        Services.appinfo.appBuildID
      )
    );
    const actualBuildID = parseInt(Services.appinfo.appBuildID);

    if (previousBuildID < actualBuildID) {
      this.show(".felt-updates-message");
    }

    Services.prefs.setStringPref(
      "enterprise.felt.previousBuildID",
      Services.appinfo.appBuildID
    );
  },

  prepareUpdateCheck() {
    this._appUpdater = new lazy.AppUpdater();
    this._updaterCallback = this.appUpdaterCallback.bind(this);
    this._appUpdater.addListener(this._updaterCallback);
    Services.obs.addObserver(this, "update-staged");
    Services.obs.addObserver(this, "update-downloaded");
    Services.obs.addObserver(this, "update-error");
  },

  forceUpdateCheck() {
    this._appUpdater
      .check()
      .catch(err => {
        console.error(`AppUpdater failure: ${err}`, err);
        this.displayLoginStateWithUpdateError("contact-admin");
      })
      .finally(() => {
        this._appUpdater.removeListener(this._updaterCallback);
      });
  },

  // Similar to browser/base/content/aboutDialog-appUpdater.js:_onAppUpdateStatus
  appUpdaterCallback(status, downloadedBytes, totalBytes) {
    console.warn(`FeltUpdates: appUpdaterCallback: status:${status}`);
    switch (status) {
      case lazy.AppUpdater.STATUS.CHECKING:
        this.scheduleDelayedUpdateCheckUI();
        break;

      // downloadedBytes / totalBytes being "undefined" will move from 0 to 10%
      case lazy.AppUpdater.STATUS.DOWNLOADING: {
        this.cancelDelayedUpdateCheckUI();
        this.hide(".felt-updates-checking");
        this.show(".felt-updates-application");

        let percent = FELT_UPDATE_APPLY_PERCENT_INIT;
        if (downloadedBytes && totalBytes) {
          // Take into account the starting point of 10%, and scale download to
          // 80%.
          percent += parseInt(
            (downloadedBytes / totalBytes) *
              (FELT_UPDATE_APPLY_PERCENT_DOWNLOAD_END -
                FELT_UPDATE_APPLY_PERCENT_INIT)
          );
        }

        this._document.querySelector("#felt-updates-progress").value = percent;
        break;
      }

      case lazy.AppUpdater.STATUS.STAGING:
        this._receivedStaging = true;
        this._document.querySelector("#felt-updates-progress").value =
          FELT_UPDATE_APPLY_PERCENT_STAGING_END;
        break;

      case lazy.AppUpdater.STATUS.READY_FOR_RESTART:
        this.hideUpdateState();
        this.automaticRestart();
        break;

      // Below are status codes that are handling error states or unexpected
      // states.

      case lazy.AppUpdater.STATUS.UPDATE_DISABLED_BY_POLICY:
        // Updates are disabled by policy, there is not much we can/should do
        this.displayLoginState();
        break;

      case lazy.AppUpdater.STATUS.OTHER_INSTANCE_HANDLING_UPDATES:
        // This should not happen, sending specific console error?
        this.displayLoginState();
        break;

      case lazy.AppUpdater.STATUS.CHECKING_FAILED:
        this.displayLoginStateWithUpdateError("checking-failed-contact-admin");
        break;

      case lazy.AppUpdater.STATUS.NO_UPDATES_FOUND:
        this.displayLoginState();
        break;

      case lazy.AppUpdater.STATUS.UNSUPPORTED_SYSTEM:
        this.displayLoginStateWithUpdateError(
          "unsupported-system-contact-admin"
        );
        break;

      case lazy.AppUpdater.STATUS.MANUAL_UPDATE:
        this.displayLoginStateWithUpdateError("contact-admin");
        break;

      case lazy.AppUpdater.STATUS.DOWNLOAD_AND_INSTALL:
        this._appUpdater.allowUpdateDownload();
        break;

      case lazy.AppUpdater.STATUS.DOWNLOAD_FAILED:
        // DOWNLOAD_FAILED after STAGING => MAR signature error.
        // During tests, this is expected
        if (this._receivedStaging && lazy.isUpdatesTesting()) {
          console.warn(
            `DOWNLOAD_FAILED after STAGING during tests, likely unsigned MAR`
          );
          this.hideUpdateState();
          return;
        }

        this.displayLoginState();
        break;

      case lazy.AppUpdater.STATUS.INTERNAL_ERROR:
        this.displayLoginStateWithUpdateError("contact-admin");
        break;

      case lazy.AppUpdater.STATUS.NEVER_CHECKED:
        // ??? Since we manually trigger this should not happen
        this.displayLoginState();
        break;

      case lazy.AppUpdater.STATUS.NO_UPDATER:
      default:
        this.displayLoginState();
        break;
    }
  },

  hide(selector) {
    const pane = this._document.querySelector(selector);
    if (pane.classList.contains("is-hidden")) {
      return;
    }
    pane.classList.add("is-hidden");
  },

  show(selector) {
    const pane = this._document.querySelector(selector);
    if (pane.classList.contains("is-hidden")) {
      pane.classList.remove("is-hidden");
    }
  },

  // Delay so that either the check is quick (fast network, no update) and there
  // is nothing valuable to show except a quick flash, or it takes longer and
  // there is value in informing the user.
  scheduleDelayedUpdateCheckUI() {
    if (this._checkingTimeout !== null) {
      return;
    }

    this._checkingTimeout = lazy.setTimeout(() => {
      this.hide(".felt-updates-application");
      this.show(".felt-updates-checking");
      this.show(".felt-updates");
    }, 500);
  },

  cancelDelayedUpdateCheckUI() {
    if (this._checkingTimeout !== null) {
      lazy.clearTimeout(this._checkingTimeout);
    }
    this._checkingTimeout = null;
  },

  displayUpdateState() {
    this.hide(".felt-login");
    this.scheduleDelayedUpdateCheckUI();
  },

  displayLoginState() {
    this.cancelDelayedUpdateCheckUI();
    this.hide(".felt-updates");
    this.hide(".felt-updates-checking");
    this.show(".felt-login");
  },

  hideUpdateState() {
    this.cancelDelayedUpdateCheckUI();
    this.hide(".felt-updates-checking");
    this.hide(".felt-updates-application");
  },

  displayLoginStateWithUpdateError(errorMsg) {
    this.hide(".felt-updates-message");
    this._errorReporter.update("felt-updates-error-messages", errorMsg);
    this.displayLoginState();
  },

  automaticRestart() {
    // Ensure the on-disk status is changed from "pending-elevate" to
    // "pending" before restarting. Without this, ProcessUpdates sees
    // ePendingElevate on the next startup and skips launching the
    // updater, while the JS layer sees STATE_PENDING and triggers
    // another restart, causing an infinite restart loop.
    Cc["@mozilla.org/updates/update-manager;1"]
      .getService(Ci.nsIUpdateManager)
      .elevationOptedIn()
      .finally(() => {
        Services.startup.quit(
          Ci.nsIAppStartup.eForceQuit | Ci.nsIAppStartup.eRestart
        );
      });
  },

  observe(subject, topic, state) {
    // We would coerce subject
    //   update = subject && subject.QueryInterface(Ci.nsIUpdate);
    // but it looks like any notifyObserver() that triggers this anyway
    // passes us a "state" directly?
    console.warn(`FeltUpdates: observer: topic:${topic} state:${state}`);
    switch (topic) {
      case "xpcom-shutdown":
        Services.obs.removeObserver(this, "update-staged");
        Services.obs.removeObserver(this, "update-downloaded");
        Services.obs.removeObserver(this, "update-error");
        Services.obs.removeObserver(this, "xpcom-shutdown");
        break;
      case "update-staged":
      case "update-downloaded":
        // states from toolkit/mozapps/update/nsIUpdateService.idl#189-191
        switch (state) {
          case "pending-elevate":
            void Cc["@mozilla.org/updates/update-manager;1"]
              .getService(Ci.nsIUpdateManager)
              .elevationOptedIn()
              .then(
                () => {
                  Services.felt?.sendUpdateReady();
                },
                err => {
                  console.error(
                    `FeltUpdates: elevationOptedIn failed for pending-elevate`,
                    err
                  );
                }
              );
            break;
          case "applied":
          case "applied-service":
          case "succeeded":
            Services.felt?.sendUpdateReady();
            break;
          default:
            console.warn(`FeltUpdates: unhandled nsIUpdate state: ${state}`);
            break;
        }
        break;
      // https://searchfox.org/enterprise-main/rev/a038f49228d707c6675ef20ce640034a64307d2e/toolkit/mozapps/update/UpdateListener.sys.mjs#366
      case "update-error":
        switch (state) {
          case "elevation-attempt-failed":
            Services.felt?.sendUpdateReady();
            break;
          case "download-attempt-failed": // this.showUpdateAvailableNotification(update, false);
          case "check-attempts-exceeded":
          case "unknown":
          case "bad-perms":
          case "download-attempts-exceeded":
          case "elevation-attempts-exceeded": // this.showManualUpdateNotification(update, false);
          default:
            console.warn(
              `FeltUpdates: unhandled nsIUpdateService error: ${state}`
            );
            break;
        }
        break;

      default:
        console.warn(`FeltUpdates: unhandled update topic: ${topic}`);
        break;
    }
  },
};
