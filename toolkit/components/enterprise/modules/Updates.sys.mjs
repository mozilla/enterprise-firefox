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
  async init(doc) {
    // Make sure that we always refer to the correct document, so we can show
    // back the login UI in any circumstance
    this._document = doc;

    this.maybeShowUpdateSuccess();
    // Check this early to avoid re-downloading updates when it would fail
    await this.updateCheckingAllowed();

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
    this._updateCheckAbandoned = false;

    if (lazy.isUpdatesTesting()) {
      // on Windows at least, during testing, make sure we let time for the UI to show up
      // before we start those actions. For some reason, not doing this ends up
      // in Marionette not starting the test code while the update applies.
      await new Promise((resolve, _) => {
        lazy.setTimeout(resolve, 5000);
      });
    }

    this.runUpdateCheckWhenConnected();

    this._initialized = true;
  },

  uninit() {
    this.unobserve();
    this.cancelDelayedUpdateCheckUI();
    this.stopWaitingForConnectivity();
    if (this._updateCheckTimeout) {
      lazy.clearTimeout(this._updateCheckTimeout);
      this._updateCheckTimeout = null;
    }
    this._document = undefined;
    this._initialized = false;
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
    Services.obs.addObserver(this, "update-staged");
    Services.obs.addObserver(this, "update-downloaded");
    Services.obs.addObserver(this, "update-error");
  },

  get _captivePortalService() {
    return Cc["@mozilla.org/network/captive-portal-service;1"].getService(
      Ci.nsICaptivePortalService
    );
  },

  // Rather than blindly starting the update check (which hangs with no
  // connectivity, e.g. behind a captive portal, and hides the login UI where
  // the captive-portal banner lives), gate it on Gecko's own connectivity
  // detection. If we aren't known to be online, reveal the login UI and defer
  // the check until connectivity is (re)gained.
  runUpdateCheckWhenConnected() {
    if (this._canDoUpdateChecking !== true) {
      // Prior-failure skip path is handled inside forceUpdateCheck().
      this.forceUpdateCheck();
      return;
    }

    const cps = this._captivePortalService;
    if (cps.state === cps.NOT_CAPTIVE || cps.state === cps.UNLOCKED_PORTAL) {
      this.beginUpdateCheck();
      return;
    }

    // UNKNOWN or LOCKED_PORTAL: the update server isn't reachable yet. Show the
    // login UI (so the captive-portal banner can appear) and wait for Gecko to
    // report connectivity before checking.
    this.displayLoginState();
    this._connectivityObserver = () => {
      this.stopWaitingForConnectivity();
      // If the user had to clear a captive portal to get online, don't run the
      // pre-login update check now: flipping back to "checking for updates"
      // (and possibly restarting for an update) right after the portal sign-in
      // would be hostile. Go straight to login; the update is caught on the
      // next launch. Only the plain UNKNOWN -> NOT_CAPTIVE case (normal online
      // startup) runs the pre-login check.
      if (cps.state === cps.UNLOCKED_PORTAL) {
        this.displayLoginState();
        return;
      }
      this.beginUpdateCheck();
    };
    Services.obs.addObserver(
      this._connectivityObserver,
      "network:captive-portal-connectivity"
    );
    // Kick a probe so we get a prompt answer (and, if captive, a banner).
    cps.recheckCaptivePortal();
  },

  stopWaitingForConnectivity() {
    if (this._connectivityObserver) {
      Services.obs.removeObserver(
        this._connectivityObserver,
        "network:captive-portal-connectivity"
      );
      this._connectivityObserver = null;
    }
  },

  beginUpdateCheck() {
    this.displayUpdateState();
    this.forceUpdateCheck();
  },

  forceUpdateCheck() {
    if (this._canDoUpdateChecking !== true) {
      lazy.log.warn(
        `FeltUpdates: forceUpdateCheck(): skip because previous updates failures`
      );
      this.displayLoginStateWithUpdateError("contact-admin");
      return;
    }

    // Don't let the update check hold the UI hostage. With no connectivity
    // (e.g. behind a captive portal) the initial check-for-updates network call
    // can hang indefinitely, and the "checking for updates" screen hides the
    // login UI -- which is where the captive-portal banner lives, so the user
    // can't even sign in to the network. If it doesn't resolve in time, give up
    // and reveal the login UI. This timeout only bounds that initial call: once
    // the server responds (appUpdaterCallback observes any status past
    // CHECKING) it is cleared, so a legitimately slow-but-working download or
    // staging phase is never mistaken for a hang.
    const timeoutMs = Services.prefs.getIntPref(
      "enterprise.felt.update_check_timeout_ms",
      10000
    );
    this._updateCheckTimeout = lazy.setTimeout(() => {
      this._updateCheckTimeout = null;
      this._updateCheckAbandoned = true;
      lazy.log.warn(
        `FeltUpdates: update check did not complete within ${timeoutMs}ms; revealing login`
      );
      this.hideUpdateState();
      this.displayLoginState();
    }, timeoutMs);

    this._appUpdater
      .check()
      .catch(err => {
        lazy.log.error(
          `Felt: forceUpdateCheck(): AppUpdater failure: ${err}`,
          err
        );
        this.displayLoginStateWithUpdateError("contact-admin");
      })
      .finally(() => {
        if (this._updateCheckTimeout !== null) {
          lazy.clearTimeout(this._updateCheckTimeout);
          this._updateCheckTimeout = null;
        }
        this._appUpdater.removeListener(this._updaterCallback);
      });
  },

  // Similar to browser/base/content/aboutDialog-appUpdater.js:_onAppUpdateStatus
  appUpdaterCallback(status, downloadedBytes, totalBytes) {
    lazy.log.warn(`FeltUpdates: appUpdaterCallback: status:${status}`);

    // STATUS.CHECKING is dispatched synchronously, before the actual network
    // round-trip; any later status means the update server responded, so
    // connectivity to it is confirmed and we should stop treating a
    // legitimately slow download/staging phase as a hang.
    if (
      status !== lazy.AppUpdater.STATUS.CHECKING &&
      this._updateCheckTimeout
    ) {
      lazy.clearTimeout(this._updateCheckTimeout);
      this._updateCheckTimeout = null;
    }

    if (this._updateCheckAbandoned) {
      // We already gave up on this check and moved the user past it (to
      // login, or beyond). Don't let a late-arriving status flip the UI back
      // to the update screens or force a restart out from under them: an
      // update that finishes downloading in the background will simply be
      // picked up by the normal update flow on a future check/restart.
      lazy.log.warn(
        `FeltUpdates: appUpdaterCallback: ignoring status ${status}, check was abandoned`
      );
      return;
    }

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
    // If we already gave up on the check (e.g. no connectivity / captive
    // portal) and revealed the login UI, don't surface an update error on top
    // of it -- the user just needs to sign in.
    if (this._updateCheckAbandoned) {
      this.displayLoginState();
      return;
    }
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
    Services.obs.removeObserver(this, "update-staged");
    Services.obs.removeObserver(this, "update-downloaded");
    Services.obs.removeObserver(this, "update-error");
    Services.obs.removeObserver(this, "xpcom-shutdown");
  },

  sendUpdateReady() {
    try {
      Services.felt?.sendUpdateReady();
    } catch (ex) {
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
        this.unobserve();
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
