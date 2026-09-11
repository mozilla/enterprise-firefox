/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AppUpdater: "resource://gre/modules/AppUpdater.sys.mjs",
  isUpdatesTesting:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  FeltErrorReport: "resource://gre/modules/enterprise/FeltErrorReport.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("Updates");
});

const FELT_UPDATE_APPLY_PERCENT_INIT = 10;
const FELT_UPDATE_APPLY_PERCENT_DOWNLOAD_END = 90;
const FELT_UPDATE_APPLY_PERCENT_STAGING_END = 100;

export const Updates = {
  _restartUpdateCheck: null,
  _restartUpdater: null,
  _nextRestartUpdateCheck: 0,
  _updateTask: Promise.resolve(),

  _queueUpdateTask(task) {
    // AppUpdater.stop() aborts all updater promises in this process.
    const result = this._updateTask.then(task);
    this._updateTask = result.catch(() => {});
    return result;
  },

  prepareForRestart() {
    if (!this._restartUpdateCheck) {
      this._restartUpdateCheck = this._queueUpdateTask(() =>
        this._prepareForRestart()
      ).finally(() => {
        this._restartUpdateCheck = null;
      });
    }
    return this._restartUpdateCheck;
  },

  async _prepareForRestart() {
    if (this._suspended || Date.now() < this._nextRestartUpdateCheck) {
      return;
    }
    await this.updateCheckingAllowed();
    if (
      !this._canDoUpdateChecking ||
      this._suspended ||
      Services.startup.shuttingDown
    ) {
      return;
    }

    const updater = new lazy.AppUpdater();
    this._restartUpdater = updater;
    const onStatus = status => {
      lazy.log.debug(`Preparing an update before restart: ${status}`);
      if (status === lazy.AppUpdater.STATUS.NO_UPDATES_FOUND) {
        this._nextRestartUpdateCheck =
          Date.now() +
          Services.prefs.getIntPref("app.update.interval", 21600) * 1000;
      }
      if (status === lazy.AppUpdater.STATUS.DOWNLOAD_AND_INSTALL) {
        updater.allowUpdateDownload();
      }
    };
    const onShutdown = () => updater.stop();
    updater.addListener(onStatus);
    Services.obs.addObserver(onShutdown, "quit-application");
    try {
      await updater.check();
    } finally {
      Services.obs.removeObserver(onShutdown, "quit-application");
      updater.removeListener(onStatus);
      updater.stop();
      this._restartUpdater = null;
    }
  },

  async init(doc) {
    if (Services.startup.shuttingDown) {
      return;
    }
    // Make sure that we always refer to the correct document, so we can show
    // back the login UI in any circumstance
    this._document = doc;

    // A prior suspend() (captive portal) may have stopped a check; init() is
    // also how CaptivePortal resumes once connectivity is confirmed.
    this._suspended = false;

    this.maybeShowUpdateSuccess();
    if (this._initialized) {
      this.displayLoginState();
      return;
    }

    void this._queueUpdateTask(() => this._initUpdateCheck()).catch(err => {
      lazy.log.error("FeltUpdates: initialization failed", err);
    });
  },

  async _initUpdateCheck() {
    if (this._suspended || this._initialized || Services.startup.shuttingDown) {
      return;
    }
    // Check this early to avoid re-downloading updates when it would fail.
    await this.updateCheckingAllowed();
    if (this._suspended || Services.startup.shuttingDown) {
      return;
    }

    Services.obs.addObserver(this, "xpcom-shutdown");

    // Make sure that observers and listeners for updates feedback and error
    // handling are registered as early as possible to avoid any risk of race
    // condition.
    this.prepareUpdateCheck();
    this._observing = true;

    this._checkingTimeout = null;
    this._receivedStaging = false;
    if (this._canDoUpdateChecking) {
      this.displayUpdateState();
    }

    if (lazy.isUpdatesTesting()) {
      // on Windows at least, during testing, make sure we let time for the UI to show up
      // before we start those actions. For some reason, not doing this ends up
      // in Marionette not starting the test code while the update applies.
      await new Promise((resolve, _) => {
        lazy.setTimeout(resolve, 5000);
      });
    }

    const check = this.forceUpdateCheck();
    this._initialized = true;
    await check;
  },

  uninit() {
    this.unobserve();
    this.cancelDelayedUpdateCheckUI();
    this._document = undefined;
    this._initialized = false;
  },

  // Stop an in-flight update check without tearing the module down: used when a
  // captive portal is detected so we don't surface an update error over the
  // portal banner. The check is re-run via init() once connectivity is back.
  suspend() {
    if (this._suspended) {
      return;
    }
    this._suspended = true;
    this.cancelDelayedUpdateCheckUI();
    this._restartUpdater?.stop();
    if (this._appUpdater) {
      this._appUpdater.removeListener(this._updaterCallback);
      // Abort the in-flight check so its network request doesn't linger behind
      // the portal (and hang shutdown if we quit before it settles).
      this._appUpdater.stop();
    }
    this.unobserve();
    this._initialized = false;
    // Show the login back so the captive-portal banner has somewhere to sit.
    this.displayLoginState();
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

  async updateCheckingAllowed() {
    const UM = Cc["@mozilla.org/updates/update-manager;1"].getService(
      Ci.nsIUpdateManager
    );
    // History is limited to 10 items, each install attempt should report a failure
    const history = await UM.getHistory().catch(ex => {
      lazy.log.error(`FeltUpdates: updateCheckingAllowed failed`, ex);
      return null;
    });
    if (history) {
      // The UpdaterManager history's capped at 10 max.
      const maxConsecutiveUpdateFailures = Math.min(
        Services.prefs.getIntPref(
          "enterprise.felt.max_consecutive_update_failure",
          3
        ),
        10
      );
      const firstNonFailed = history.findIndex(
        update => update.state !== "failed"
      );
      const consecutiveUpdateFailures =
        firstNonFailed === -1 ? history.length : firstNonFailed;
      lazy.log.warn(
        `FeltUpdates: updateCheckingAllowed: ${consecutiveUpdateFailures}, max ${maxConsecutiveUpdateFailures}`
      );
      if (consecutiveUpdateFailures > maxConsecutiveUpdateFailures) {
        lazy.log.warn(
          `FeltUpdates: updateCheckingAllowed: skip startup update check because consecutive update failures: ${consecutiveUpdateFailures}, max ${maxConsecutiveUpdateFailures}`
        );
        this._canDoUpdateChecking = false;
        return;
      }
    }

    this._canDoUpdateChecking = true;
  },

  prepareUpdateCheck() {
    this._appUpdater = new lazy.AppUpdater();
    this._updaterCallback = this.appUpdaterCallback.bind(this);
    this._appUpdater.addListener(this._updaterCallback);
    Services.obs.addObserver(this, "felt-ready");
    Services.obs.addObserver(this, "update-staged");
    Services.obs.addObserver(this, "update-downloaded");
    Services.obs.addObserver(this, "update-error");
  },

  async forceUpdateCheck() {
    if (this._canDoUpdateChecking !== true) {
      lazy.log.warn(
        `FeltUpdates: forceUpdateCheck(): skip because previous updates failures`
      );
      this.displayLoginStateWithUpdateError("contact-admin");
      return;
    }

    await this._appUpdater
      .check()
      .catch(err => {
        if (this._suspended) {
          return;
        }
        lazy.log.error(
          `Felt: forceUpdateCheck(): AppUpdater failure: ${err}`,
          err
        );
        this.displayLoginStateWithUpdateError("contact-admin");
      })
      .finally(() => {
        this._appUpdater.removeListener(this._updaterCallback);
      });
  },

  // Similar to browser/base/content/aboutDialog-appUpdater.js:_onAppUpdateStatus
  appUpdaterCallback(status, downloadedBytes, totalBytes) {
    if (this._suspended) {
      return;
    }
    lazy.log.warn(`FeltUpdates: appUpdaterCallback: status:${status}`);
    switch (status) {
      case lazy.AppUpdater.STATUS.CHECKING:
        this.scheduleDelayedUpdateCheckUI();
        break;

      // downloadedBytes / totalBytes being "undefined" will move from 0 to 10%
      case lazy.AppUpdater.STATUS.DOWNLOADING: {
        this.cancelDelayedUpdateCheckUI();
        this.displayUpdateDownloadingPanel();

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
        this.displayLoginStateWithUpdateWarning(
          "felt-warning-unsupported-system-contact-admin",
          "warning-unsupported-system-contact-admin"
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
          lazy.log.warn(
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
      this.displayUpdateCheckingPanel();
    }, 500);
  },

  cancelDelayedUpdateCheckUI() {
    if (this._checkingTimeout !== null) {
      lazy.clearTimeout(this._checkingTimeout);
    }
    this._checkingTimeout = null;
  },

  displayUpdateCheckingPanel() {
    this.hide(".felt-updates-application");
    this.show(".felt-updates-checking");
    this.show(".felt-updates");
  },

  displayUpdateDownloadingPanel() {
    this.hide(".felt-updates-checking");
    this.show(".felt-updates-application");
    this.show(".felt-updates");
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
    lazy.FeltErrorReport.update("felt-updates-error-messages", errorMsg);
    this.displayLoginState();
  },

  displayLoginStateWithUpdateWarning(warningTitle, warningMsg) {
    this.hide(".felt-updates-message");
    lazy.FeltErrorReport.update("felt-updates-warning-messages", warningMsg);
    const warning = this._document.querySelector(
      ".felt-updates-warning-messages"
    );
    if (warning) {
      this._document.l10n.setAttributes(warning, warningTitle, {});
    }
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

  unobserve() {
    // suspend() can run before init() has registered its observers (a portal
    // detected during init's await), so only remove what we actually added.
    if (!this._observing) {
      return;
    }
    this._observing = false;
    Services.obs.removeObserver(this, "felt-ready");
    Services.obs.removeObserver(this, "update-staged");
    Services.obs.removeObserver(this, "update-downloaded");
    Services.obs.removeObserver(this, "update-error");
    Services.obs.removeObserver(this, "xpcom-shutdown");
  },

  sendUpdateReady() {
    try {
      Services.felt?.sendUpdateReady();
      this._pendingUpdateReady = false;
    } catch (ex) {
      this._pendingUpdateReady = true;
      if (ex.result === Cr.NS_ERROR_NOT_CONNECTED) {
        lazy.log.warn(
          `FeltUpdates: sendUpdateReady() failed because not connected: no browser ?`
        );
      } else if (ex.result === Cr.NS_ERROR_CONNECTION_REFUSED) {
        lazy.log.warn(`FeltUpdates: sendUpdateReady() failed to send`);
      } else {
        throw ex;
      }
    }
  },

  observe(subject, topic, state) {
    // We would coerce subject
    //   update = subject && subject.QueryInterface(Ci.nsIUpdate);
    // but it looks like any notifyObserver() that triggers this anyway
    // passes us a "state" directly?
    lazy.log.warn(`FeltUpdates: observer: topic:${topic} state:${state}`);
    switch (topic) {
      case "xpcom-shutdown":
        // Abort an in-flight check so its network request doesn't hang shutdown.
        this._appUpdater?.stop();
        this.unobserve();
        break;
      case "felt-ready":
        lazy.log.warn(
          "Browser is ready checking for pending update notification"
        );
        if (this._pendingUpdateReady) {
          lazy.log.warn("Informing browser of pending update");
          this.sendUpdateReady();
        }
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
                  this.sendUpdateReady();
                },
                err => {
                  lazy.log.error(
                    `FeltUpdates: elevationOptedIn failed for pending-elevate`,
                    err
                  );
                }
              );
            break;
          case "applied":
          case "applied-service":
          case "succeeded":
            this.sendUpdateReady();
            break;
          default:
            lazy.log.warn(`FeltUpdates: unhandled nsIUpdate state: ${state}`);
            break;
        }
        break;
      // https://searchfox.org/enterprise-main/rev/a038f49228d707c6675ef20ce640034a64307d2e/toolkit/mozapps/update/UpdateListener.sys.mjs#366
      case "update-error":
        if (this._suspended) {
          break;
        }
        switch (state) {
          case "elevation-attempt-failed":
            this.displayLoginStateWithUpdateWarning(
              "felt-warning-title-elevation-attempt-failed",
              "warning-elevation-attempt-failed-contact-admin"
            );
            this.sendUpdateReady();
            break;
          case "download-attempt-failed":
            this.displayLoginStateWithUpdateWarning(
              "felt-warning-title-download-attempt-failed",
              "warning-download-attempt-failed-contact-admin"
            );
            break;
          case "check-attempts-exceeded":
          case "unknown":
          case "bad-perms":
          case "download-attempts-exceeded":
          case "elevation-attempts-exceeded":
          default:
            lazy.log.warn(
              `FeltUpdates: unhandled nsIUpdateService error: ${state}`
            );
            break;
        }
        break;

      default:
        lazy.log.warn(`FeltUpdates: unhandled update topic: ${topic}`);
        break;
    }
  },
};
