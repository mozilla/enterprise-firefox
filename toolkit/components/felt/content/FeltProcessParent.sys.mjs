/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  CONSOLE_ADDRESS_PREF:
    "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  isBuildAppBrowser:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  isTesting: "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  FeltCommon: "chrome://felt/content/FeltCommon.sys.mjs",
  FeltStorage: "resource://gre/modules/enterprise/FeltStorage.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

if (lazy.isBuildAppBrowser()) {
  ChromeUtils.defineESModuleGetters(lazy, {
    // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
    gFeltPendingURLs: "resource:///modules/FeltURLHandler.sys.mjs",
    // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
    resetFeltFirefoxWindowReady: "resource:///modules/FeltURLHandler.sys.mjs",
    // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
    FELT_OPEN_WINDOW_DISPOSITION: "resource:///modules/FeltURLHandler.sys.mjs",
  });
}

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("FeltProcessParent");
});

ChromeUtils.defineLazyGetter(lazy, "logProcess", () => {
  return lazy.createEnterpriseLogger("FeltBrowser");
});

const PROCESS_START_REASON = {
  INITIAL_START: "initial-start",
  RESTART: "restart",
  CRASH: "crash",
};

export function queueURL(payload) {
  // If Firefox AND Felt are both ready, forward immediately
  if (
    gFeltProcessParentInstance?.firefoxReady &&
    gFeltProcessParentInstance?.feltReady
  ) {
    gFeltProcessParentInstance.sendURLToFirefox(payload);
    // Ensure Felt launcher stays hidden when forwarding to running Firefox
    Services.felt.makeBackgroundProcess(true);
  } else {
    // Queue at module level until ready
    lazy.gFeltPendingURLs.push(payload).catch(err => {
      lazy.log.error("Failed to persist pending Felt URL", err);
    });
    Services.cpmm.sendAsyncMessage("FeltParent:ForceFeltFocus", {});
  }
}

let gFeltProcessParentInstance = null;

function extractURLPayload(payload) {
  return {
    url: payload.url ?? "",
    disposition:
      payload.disposition ?? lazy.FELT_OPEN_WINDOW_DISPOSITION.DEFAULT,
  };
}

let gFeltFirefoxReadyNotified = false;

export function isFeltFirefoxWindowReady() {
  return (
    gFeltProcessParentInstance?.firefoxReady &&
    gFeltProcessParentInstance?.feltReady
  );
}

function notifyFirefoxReady() {
  if (gFeltFirefoxReadyNotified) {
    return;
  }
  if (!isFeltFirefoxWindowReady()) {
    return;
  }
  gFeltFirefoxReadyNotified = true;
  lazy.log.debug("Notifying felt-firefox-window-ready");
  Services.obs.notifyObservers(null, "felt-firefox-window-ready");
}

// These observer topics relay IPC events from the Firefox subprocess back
// through XPCOM. Their lifetime is tied to the Firefox process, not the
// JSActor pair (which can be destroyed and re-created independently when the
// content process hosting the SSO page is recycled). We register them once on
// first use via gObserversRegistered and never remove them: the browserObserver
// dispatches through gFeltProcessParentInstance (module-level), so a single
// registration remains valid across actor re-creations and Firefox restart
// cycles. They are cleaned up implicitly when the Felt UI process exits.
// See browserObserver.observe() which routes all events via the singleton:
// https://github.com/mozilla/enterprise-firefox/blob/3caad8cb1f33/browser/extensions/felt/content/FeltProcessParent.sys.mjs#L111-L183
const kBrowserObserverTopics = [
  "felt-firefox-exiting",
  "felt-firefox-restarting",
  "felt-ready",
  "felt-firefox-logout",
  "felt-firefox-tokens",
  "felt-firefox-refresh-tokens",
];

let gObserversRegistered = false;

/**
 * Manages the SSO login and launching Firefox
 */
export class FeltProcessParent extends JSProcessActorParent {
  constructor() {
    lazy.log.debug(`FeltParentProcess.sys.mjs: FeltProcessParent`);
    super();

    // Store instance globally
    gFeltProcessParentInstance = this;

    // Track Firefox ready state (URLs remain in gFeltPendingURLs until ready)
    this.firefoxReady = false;
    // Track Felt ready state (it must register its observer)
    this.feltReady = false;
    // Current loggedInUserInfo
    this.loggedInUserInfo = null;

    this.abnormalExitCounter = 0;

    // Amount of abnormal exit to allow over abnormal_exit_period
    this.abnormalExitLimit = Services.prefs.getIntPref(
      "enterprise.browser.abnormal_exit_limit",
      3
    );

    /* Time period (in seconds) considered for checking the amount of abnormal
     * exits. Hitting the limit defined above within this period will stop
     * automatic restart and show user an error.
     *
     * confere shouldAbortRestarting()
     */
    this.abnormalExitPeriod = Services.prefs.getIntPref(
      "enterprise.browser.abnormal_exit_period",
      120
    );
    this.abnormalExitFirstTime = 0;

    this.browserObserver = {
      observe(aSubject, aTopic, aData) {
        lazy.log.debug(`ParentProcess: Received ${aTopic}`);
        switch (aTopic) {
          case "felt-firefox-exiting": {
            gFeltProcessParentInstance.exitReported = true;
            break;
          }

          case "felt-firefox-restarting": {
            if (gFeltProcessParentInstance) {
              gFeltProcessParentInstance.restartReported = true;
              gFeltProcessParentInstance.firefox = null;
            }

            const proc = gFeltProcessParentInstance?.proc;
            const restartDisabled = Services.prefs.getBoolPref(
              "enterprise.disable_restart",
              false
            );

            const UM = Cc["@mozilla.org/updates/update-manager;1"].getService(
              Ci.nsIUpdateManager
            );
            UM.getReadyUpdate()
              .then(readyUpdate => {
                let pendingUpdate = false;
                if (readyUpdate) {
                  // Updates states when restarting will finish the update
                  const readyStates = [
                    "pending",
                    "pending-service",
                    "pending-elevate",
                    "applied",
                    "applied-service",
                  ];
                  pendingUpdate = readyStates.includes(readyUpdate.state);
                }
                return pendingUpdate;
              })
              .catch(err => {
                lazy.log.debug(`ParentProcess: getReadyUpdate failed: ${err}`);
              })
              .then(pendingUpdate => {
                lazy.log.debug(
                  `ParentProcess: restart notification, restartDisabled=${restartDisabled}`
                );
                if (proc) {
                  lazy.log.debug(
                    `ParentProcess: Waiting for Firefox PID=${proc.pid} to exit for restart`
                  );

                  // exitPromise never rejects and has no timeout. kill after a timeout, set above the
                  // toolkit.asyncshutdown.crash_timeout, to avoid hangs if the child is truly unresponsive.
                  const restartShutdownTimeout = Services.prefs.getIntPref(
                    "enterprise.browser.restart_shutdown_timeout",
                    90000
                  );
                  const forceKillTimer = lazy.setTimeout(() => {
                    if (proc.exitCode === null) {
                      lazy.log.error(
                        `ParentProcess: Firefox PID=${proc.pid} did not exit within ${restartShutdownTimeout}ms; killing for restart`
                      );
                      proc.kill();
                    }
                  }, restartShutdownTimeout);

                  proc.exitPromise
                    .then(() => {
                      lazy.clearTimeout(forceKillTimer);
                      lazy.log.debug(
                        `ParentProcess: Firefox exited for restart, restartDisabled=${restartDisabled}`
                      );

                      if (!restartDisabled && !pendingUpdate) {
                        lazy.log.debug(`ParentProcess: Starting new Firefox`);
                        gFeltProcessParentInstance.startFirefox(
                          PROCESS_START_REASON.RESTART
                        );
                      } else if (pendingUpdate) {
                        lazy.log.debug(
                          `ParentProcess: Restart requested and pending update, restarting FELT UI`
                        );
                        Services.cpmm.sendAsyncMessage(
                          "FeltParent:FirefoxRestartUpdateExit",
                          {}
                        );
                      } else {
                        lazy.log.debug(
                          `ParentProcess: Restart disabled, sending normal exit to restore FELT UI`
                        );
                        Services.cpmm.sendAsyncMessage(
                          "FeltParent:FirefoxNormalExit",
                          {}
                        );
                      }
                    })
                    .catch(err => {
                      lazy.clearTimeout(forceKillTimer);
                      lazy.log.error(
                        `ParentProcess: Restart continuation failed after exit: ${err}; sending normal exit`
                      );
                      Services.cpmm.sendAsyncMessage(
                        "FeltParent:FirefoxNormalExit",
                        {}
                      );
                    });
                } else {
                  lazy.log.debug(`ParentProcess: No proc to wait for!`);
                }
              })
              .catch(err => {
                lazy.log.error(
                  `ParentProcess: Restart failed: ${err}; killing proc and quitting via normal exit`
                );
                proc?.kill();
                Services.cpmm.sendAsyncMessage(
                  "FeltParent:FirefoxNormalExit",
                  {}
                );
              });
            break;
          }
          case "felt-ready": {
            if (gFeltProcessParentInstance) {
              gFeltProcessParentInstance.feltReady = true;
              if (lazy.isBuildAppBrowser()) {
                gFeltProcessParentInstance.forwardPendingURLs().catch(err => {
                  lazy.log.error("Failed to forward pending URLs", err);
                });
              }
              notifyFirefoxReady();
            }
            break;
          }

          case "felt-firefox-logout":
            gFeltProcessParentInstance.logoutFirefox(aData);
            break;

          case "felt-firefox-tokens": {
            const data = JSON.parse(aData);
            Services.felt.setTokens(
              data.access_token,
              data.refresh_token,
              data.expires_at
            );
            break;
          }

          case "felt-firefox-refresh-tokens": {
            lazy.log.debug(`ParentProcess: Trigger a token refresh in FELT.`);
            if (gFeltProcessParentInstance.logoutReported) {
              lazy.log.debug(
                "ParentProcess: logout in progress, skipping token refresh."
              );
              break;
            }
            const client = lazy.ConsoleClient;
            client
              .refreshTokens()
              .then(({ access_token, refresh_token, expires_at }) => {
                lazy.log.debug("refreshTokens successful");
                Services.felt.setTokens(
                  access_token,
                  refresh_token,
                  expires_at
                );
                Services.felt.sendAccessToken();
              })
              .catch(error => {
                // A refresh failure tears the browser down.
                // TODO: define a more refined behaviour for these conditions and implement.
                // For example, an intermittent network or 5xx error can be handled more
                // gracefully if the refresh request is still before the actual token expiration
                // because the known old token still has some validity time left.
                lazy.log.error(
                  `token refresh failed (${error.name}), shutting down Firefox`,
                  error
                );
                Services.felt.clearTokens();
                gFeltProcessParentInstance.logoutReported = true;
                gFeltProcessParentInstance.proc.exitPromise.then(_ => {
                  Services.cpmm.sendAsyncMessage(
                    "FeltParent:FirefoxSessionInterrupted",
                    {
                      reason:
                        error.name === "ReauthRequiredError"
                          ? "tokenRefreshExpired"
                          : "tokenRefreshFailed",
                    }
                  );
                });
                Services.felt.shutdownFirefox();
              });
            break;
          }

          default:
            lazy.log.debug(`ParentProcess: Unhandled ${aTopic}`);
            break;
        }
      },
    };
  }

  async sendPrefsToFirefox() {
    Services.felt.sendStringPreference(
      lazy.CONSOLE_ADDRESS_PREF,
      await lazy.ConsoleClient.consoleBaseURI
    );
  }

  /**
   * Fetches the configurations for Firefox and sends
   * each configuration point over to Firefox as preferences
   */
  async _applyFirefoxConfigs() {
    const {
      learn_more_url,
      company_logo_url,
      policies: { polling_frequency },
      services: { push_url, remote_settings_url, tokenserver_url },
      extra_prefs,
    } = await lazy.ConsoleClient.getFirefoxConfigs();

    if (learn_more_url === null) {
      lazy.log.error("No learn_more_url in Firefox configuration");
    } else {
      Services.felt.sendStringPreference(
        "enterprise.configs.learn_more_url",
        learn_more_url
      );
    }

    if (company_logo_url === null) {
      lazy.log.error("No company_logo_url in Firefox configuration");
    } else {
      Services.felt.sendStringPreference(
        "enterprise.configs.company_logo_url",
        company_logo_url
      );
    }

    if (polling_frequency === null) {
      lazy.log.error("No polling_frequency in Firefox configuration");
    } else {
      Services.felt.sendIntPreference(
        "enterprise.policies.live.polling_interval",
        polling_frequency
      );
    }

    if (tokenserver_url === null) {
      lazy.log.error("No tokenserver_url in Firefox configuration");
    } else {
      Services.felt.sendStringPreference(
        "identity.sync.tokenserver.uri",
        tokenserver_url
      );
    }

    if (remote_settings_url === null) {
      lazy.log.error("No remote_settings_url in Firefox configuration");
    } else {
      Services.felt.sendStringPreference(
        "services.settings.server",
        remote_settings_url
      );
    }

    if (push_url === null) {
      lazy.log.error("No push_url in Firefox configuration");
    } else {
      Services.felt.sendStringPreference("dom.push.serverURL", push_url);
    }

    extra_prefs.forEach(pref => {
      this._setPrefInFirefox(pref);
    });
  }

  /**
   * Sends preference to Firefox through felt
   *
   * @param {[key: string, value: boolean|string|number]} pref
   */
  _setPrefInFirefox(pref) {
    const name = pref[0];
    const value = pref[1];
    lazy.log.debug(
      `Sending preference ${name} with value ${value} from Felt to Firefox`
    );

    switch (typeof value) {
      case "boolean":
        Services.felt.sendBoolPreference(name, value);
        break;

      case "string":
        Services.felt.sendStringPreference(name, value);
        break;

      case "number":
        Services.felt.sendIntPreference(name, value);
        break;

      default:
        lazy.log.warn(`Unsupported pref type for ${name}:`, value);
    }
  }

  async startFirefox(startReason, ssoCollectedCookies = []) {
    this.restartReported = false;
    this.logoutReported = false;
    this.exitReported = false;
    this.firefoxReady = false;
    this.feltReady = false;
    if (lazy.isBuildAppBrowser()) {
      // This also part of FeltURLHandler that cannot be loaded in non browser
      // applications.
      lazy.resetFeltFirefoxWindowReady();
    }
    gFeltFirefoxReadyNotified = false;

    // There is no message being sent to the message listener on restart phases
    // whether it is a requested restart from the browser or from a crash.
    // However in those cases there would have been a start message being sent
    // making us trying to close a Felt window that was not re-opened.
    // Since there is no message sent on browser process exit in both cases,
    // then make sure to also not send a matching starting message.
    if (startReason === PROCESS_START_REASON.INITIAL_START) {
      Services.cpmm.sendAsyncMessage("FeltParent:TransitionFeltToBackground", {
        startReason,
      });
    }

    if (!gObserversRegistered) {
      kBrowserObserverTopics.forEach(aTopic => {
        Services.obs.addObserver(this.browserObserver, aTopic);
      });
      gObserversRegistered = true;
    }

    // Fetch primarySecret from the console BEFORE spawning Firefox. The child's
    // storage encryption layer (mozStorage / obfsvfs) blocks at
    // profile-do-change waiting for it to unlock the
    // `lockstore::kek::password:sqlite` Password KEK, so the browser cannot
    // function without it. ConsoleClient.getPrimarySecret() already refreshes
    // the session and retries once on an auth failure. If the fetch fails,
    // abort the launch rather than spawn a browser that hangs waiting for a
    // secret that never arrives. The value is held only in this local until it
    // is relayed to the spawned browser below; Felt never stores it.
    let primarySecret;
    try {
      const payload = await lazy.ConsoleClient.getPrimarySecret();
      primarySecret = payload?.data;
    } catch (e) {
      lazy.log.error(`startFirefox: getPrimarySecret() failed: ${e}`);
    }
    if (!primarySecret) {
      // The spawned browser cannot open its encrypted profile databases
      // without the primarySecret, so do not launch it. Surface a dedicated
      // primarySecret error to the user rather than leaving Felt backgrounded
      // with no browser (Bug 1996558).
      lazy.log.error(
        "startFirefox: primarySecret unavailable; aborting browser launch"
      );
      // TODO(Bug 1996558): errorType is currently only "primarySecret";
      // wiring distinct UI/wording per errorType is tracked separately.
      Services.cpmm.sendAsyncMessage("FeltParent:FirefoxLaunchFailure", {
        errorType: "primarySecret",
      });
      return;
    }

    this.firefox = this.startFirefoxProcess();
    this.firefox
      .then(async () => {
        // Send primarySecret FIRST, before any other state, so the
        // child's storage encryption KEK is unlocked before any
        // mozStorage consumer opens a database. This bypasses the
        // `firefoxReady=true` gate that sendAccessToken / sendReady
        // wait for. The browser hands it straight to the storage layer
        // on receipt; neither side stores it. A failure here means the
        // child can never unlock its profile, so abort with the dedicated
        // primarySecret error rather than spawn a browser that hangs.
        try {
          Services.felt.sendPrimarySecret(primarySecret);
        } catch (e) {
          lazy.log.error(
            `startFirefox: sendPrimarySecret failed: ${e}; aborting browser launch`
          );
          Services.cpmm.sendAsyncMessage("FeltParent:FirefoxLaunchFailure", {
            errorType: "primarySecret",
          });
          return;
        }
        await this.sendPrefsToFirefox();
        Services.felt.sendAccessToken();

        await this._applyFirefoxConfigs();

        Services.felt.sendCookies(ssoCollectedCookies);
        Services.felt.sendReady();
        this.firefoxReady = true;

        if (lazy.isBuildAppBrowser()) {
          // Try to forward pending URLs now (will only forward if felt is also ready)
          await this.forwardPendingURLs();
        }
        notifyFirefoxReady();
      })
      .then(() => {
        lazy.log.debug(
          `firefox: waiting on proc PID ${this.proc.pid}`,
          this.proc
        );

        this.proc.exitPromise.then(ev => {
          lazy.log.debug(`firefox exit: ev`, JSON.stringify(ev));
          lazy.log.debug(
            `firefox exit: PID:${this.proc.pid} exitCode:${JSON.stringify(this.proc.exitCode)}`
          );

          if (!this.restartReported && !this.logoutReported) {
            if (this.proc.exitCode === 0) {
              this.abnormalExitCounter = 0;
              this.abnormalExitFirstTime = 0;
              Services.cpmm.sendAsyncMessage(
                "FeltParent:FirefoxNormalExit",
                {}
              );
            } else {
              this.handleRestartAfterAbnormalExit();
            }
          }
        });
      })
      .catch(err => {
        lazy.log.error(
          `Firefox launch failure (${err.result} / ${err.name}): ${err.message}`
        );
        Services.cpmm.sendAsyncMessage("FeltParent:FirefoxLaunchFailure", {
          errorType: "launchFailure",
        });
      });
  }

  /**
   * Handles the abnormal exit and decides whether to restart the Firefox
   * again or to inform the user of the set of crashes.
   */
  handleRestartAfterAbnormalExit() {
    if (
      this.proc.exitCode ===
      Ci.nsIFelt.FeltEncryptionExitCode_SdrTokenUnlockFailed
    ) {
      // The profile could not be unlocked (missing or rejected primary secret).
      // Restarting cannot fix a wrong or rotated secret, so surface a clear
      // error instead of counting this as a crash (Bug 2021342).
      this.abnormalExitCounter = 0;
      this.abnormalExitFirstTime = 0;
      Services.cpmm.sendAsyncMessage("FeltParent:FirefoxLaunchFailure", {
        errorType: "sdrTokenUnlockFailed",
      });
      return;
    }

    if (this.proc.exitCode === Ci.nsIFelt.FeltEncryptionExitCode_Delete) {
      // Firefox encryption explicitely reported to delete the profile folder
      // The profile service should do it but it may be incomplete depending
      // on how the profile was locked.
      lazy.log.debug(
        `Encryption reported FeltEncryptionExitCode_Delete, ensure profile directory cleanup`
      );
      if (this.proc.profilePath) {
        const defProfRt = Services.dirsvc.get("DefProfRt", Ci.nsIFile);
        const profD = Cc["@mozilla.org/file/local;1"].createInstance(
          Ci.nsIFile
        );
        profD.initWithPath(this.proc.profilePath);
        // Before removing, ensure the profile path is a direct child of the
        // directory holding profiles.
        if (profD.parent && profD.parent.equals(defProfRt)) {
          lazy.log.debug(`Encryption cleanup: ${this.proc.profilePath}`);
          IOUtils.remove(this.proc.profilePath, {
            ignoreAbsent: true,
            recursive: true,
            retryReadonly: true,
          }).catch(error =>
            lazy.log.debug(
              `Encryption cleanup IOUtils.remove() failed: ${error}`
            )
          );
        } else {
          lazy.log.debug(
            `Encryption cleanup skipped: ${this.proc.profilePath} not direct child of ${defProfRt.path}`
          );
        }
      }
      this.proc.profilePath = null;
    }

    lazy.log.debug(
      `Firefox: handleRestartAfterAbnormalExit: this.exitReported=${this.exitReported}`
    );
    if (this.exitReported) {
      lazy.log.debug("Abort restarting Firefox, crash was shutdown crash.");
      Services.cpmm.sendAsyncMessage("FeltParent:FirefoxNormalExit", {});
      return;
    }

    if (this.abnormalExitCounter === 0) {
      this.abnormalExitFirstTime =
        Services.telemetry.msSinceProcessStart() / 1000;
    }
    this.abnormalExitCounter += 1;

    if (this.shouldAbortRestarting()) {
      lazy.log.debug(
        "Abort restarting Firefox and inform the user of the crashes."
      );
      Services.cpmm.sendAsyncMessage("FeltParent:FirefoxAbnormalExit", {});
    } else {
      lazy.log.debug("Trying to restart Firefox again.");
      this.startFirefox(PROCESS_START_REASON.CRASH);
    }
  }

  /**
   * Checks the state of the recent abnormal exits, meaning whether the crashes
   * counter exceeds a pre-set counter limit within a pre-set time period.
   *
   * @returns {boolean} Whether these "abnormal" thresholds are exceeded.
   */
  shouldAbortRestarting() {
    lazy.log.debug(
      `Firefox AbnormalExit abnormalExitLimit=${this.abnormalExitLimit} abnormalExitCounter=${this.abnormalExitCounter} ; firstTime=${this.abnormalExitFirstTime} abnormalExitPeriod=${this.abnormalExitPeriod}`
    );
    // Have we reached the limit of allowed crashes ?
    const isExceedingCrashCounterLimit =
      this.abnormalExitCounter >= this.abnormalExitLimit;
    // How much time since the first crash we recorded in this session ?
    const timeSinceFirstCrash =
      Services.telemetry.msSinceProcessStart() / 1000 -
      this.abnormalExitFirstTime;
    // Is the time since first crash too recent ?
    const isWithinCrashPeriod = timeSinceFirstCrash <= this.abnormalExitPeriod;
    lazy.log.debug(
      `Firefox AbnormalExit crashLimitHit=${isExceedingCrashCounterLimit} timeSinceFirstCrash=${timeSinceFirstCrash} crashedNotLongAgoEnough=${isWithinCrashPeriod}`
    );
    return isExceedingCrashCounterLimit && isWithinCrashPeriod;
  }

  async startFirefoxProcess() {
    let socket = Services.felt.oneShotIpcServer();

    const firefoxBin = Services.felt.binPath();

    let profilePath = Services.prefs.getStringPref(
      "enterprise.profile_path",
      ""
    );
    let foundProfile = null;

    if (!profilePath) {
      let profileService = Cc[
        "@mozilla.org/toolkit/profile-service;1"
      ].getService(Ci.nsIToolkitProfileService);

      let profileName = await this.profileName();

      for (let profile of profileService.profiles) {
        if (profile.name === profileName) {
          foundProfile = profile;
          break;
        }
      }

      if (!foundProfile) {
        lazy.log.debug(`creating new ${profileName} profile`);
        foundProfile = profileService.createProfile(
          null,
          profileName,
          "felt-firstrun"
        );

        await profileService.asyncFlush();
      }
    } else if (Services.appinfo.OS == "WINNT") {
      profilePath = PathUtils.normalize(profilePath.replaceAll("/", "\\"));
    }

    let extraRunArgs = [];
    if (lazy.isTesting()) {
      extraRunArgs = [
        "--marionette",
        "--remote-allow-hosts",
        "localhost",
        "--remote-allow-system-access",
      ];
    }

    let startupCache = Cc["@mozilla.org/startupcacheinfo;1"].getService(
      Ci.nsIStartupCacheInfo
    );

    // If we rebuilt the startup cache then have the new profile purge its
    // caches too.
    if (startupCache.IgnoreDiskCache || !startupCache.FoundDiskCacheOnInit) {
      extraRunArgs.push("-purgecaches");
    }

    if (Services.felt.isFeltSafeMode()) {
      extraRunArgs.push("--safe-mode");
    }

    let profileArgs = [];
    if (profilePath) {
      profileArgs = ["--profile", profilePath];
    }

    if (foundProfile) {
      profileArgs = ["-P", foundProfile.name];
    }

    lazy.log.debug(`Using profileArgs: ${profileArgs}`);
    const firefoxRunArgs = [
      "--foreground",
      ...profileArgs,
      "-felt",
      socket,
      ...extraRunArgs,
    ];

    const firefoxRun = {
      command: firefoxBin,
      arguments: firefoxRunArgs,
      stderr: "pipe",
      /* environmentAppend: true,
      environment: env, */
    };

    try {
      this.proc = await lazy.Subprocess.call(firefoxRun);
      this.proc.profilePath = foundProfile?.rootDir.path || profilePath;
    } catch (e) {
      lazy.log.error("Failed to launch Firefox: ", e.message);
      throw e;
    }

    this.onPipeDataAvailable(this.proc.stdout, this.proc.pid, (pid, chunk) => {
      lazy.logProcess.info(`[${pid}]: ${chunk}`);
    });

    this.onPipeDataAvailable(this.proc.stderr, this.proc.pid, (pid, chunk) => {
      lazy.logProcess.error(`[${pid}]: ${chunk}`);
    });

    Services.felt.ipcChannel();
  }

  /**
   * Drain a pipe when data is available. Not draining may result in pipe
   * being blocked on the write side, blocking the browser.
   *
   * @callback dataCallback
   *
   * @param {object} pipe - The pipe to work on, from Subprocess.call() return value
   * @param {int} pid - The PID pf the process which will be drained
   * @param {dataCallback} callback - The callback handling what to do with the data
   */
  async onPipeDataAvailable(pipe, pid, callback) {
    if (!pipe) {
      return;
    }

    const decoder = new TextDecoder("utf-8");
    let lineBuffer = "";

    try {
      while (true) {
        let buffer = await pipe.read();
        if (!buffer || buffer.byteLength === 0) {
          break;
        }

        lineBuffer += decoder.decode(buffer, { stream: true });

        // Split by lines so logProcess receives complete log messages
        let lines = lineBuffer.split("\n");
        // Keep the last incomplete line in the buffer
        lineBuffer = lines.pop();

        for (let line of lines) {
          if (line.trim()) {
            try {
              callback(pid, line);
            } catch (e) {
              lazy.log.error(`Error while callback for pipe draining`, e);
            }
          }
        }
      }

      // Flush remaining buffer & decoder tail when stream closes
      lineBuffer += decoder.decode();
      if (lineBuffer.trim()) {
        try {
          callback(pid, lineBuffer);
        } catch (e) {
          lazy.log.error(`Error while callback for pipe drain finalization`, e);
        }
      }
    } catch (e) {
      // Pipe explicitly closed or process killed
    } finally {
      // Force release underlying stream resources
      try {
        await pipe.close();
      } catch (e) {
        // Ignore if already closed
      }
    }
  }

  /**
   * Send a URL request to Firefox via IPC (Firefox must be ready)
   *
   * @param {object} payload - Object with url and disposition properties
   */
  sendURLToFirefox(payload) {
    if (!this.firefoxReady || !Services.felt) {
      lazy.log.error(`Cannot send URL, Firefox not ready`);
      return;
    }

    try {
      let { url, disposition } = extractURLPayload(payload);
      Services.felt.openURL(url, disposition);
    } catch (err) {
      lazy.log.error(`Failed to forward URL: ${err}`);
    }
  }

  /**
   * Forward all pending URLs to Firefox
   */
  async forwardPendingURLs() {
    await lazy.gFeltPendingURLs.init();

    if (lazy.gFeltPendingURLs.length === 0) {
      return;
    }

    // Wait for both Firefox (prefs/cookies) AND felt (observer) to be ready
    if (!this.firefoxReady || !this.feltReady) {
      lazy.log.debug(
        `Not ready to forward URLs (firefoxReady=${this.firefoxReady}, feltReady=${this.feltReady})`
      );
      return;
    }

    if (!Services.felt) {
      lazy.log.error(`Services.felt not available, cannot forward URLs`);
      return;
    }

    // Forward all URLs directly via IPC (both Firefox and felt are ready)
    for (const payload of lazy.gFeltPendingURLs) {
      try {
        let { url, disposition } = extractURLPayload(payload);
        Services.felt.openURL(url, disposition);
      } catch (err) {
        lazy.log.error(`Failed to forward URL: ${err}`);
      }
    }

    // Clear the queue
    lazy.gFeltPendingURLs.clear();
  }

  /**
   * Perform all the logout operations on FELT side.
   *
   * @param {string} reason - The reason for logout, default is empty string for user-initiated logout.
   */
  logoutFirefox(reason = "") {
    if (!Services.felt.isFeltUI()) {
      throw new Error("Logout handling should only happen on FELT side.");
    }

    if (gFeltProcessParentInstance.logoutReported) {
      lazy.log.debug("logoutFirefox: logout already in progress, skipping.");
      return;
    }

    lazy.log.debug(
      `Logout (reason: ${reason || "user"}), waiting on process ${
        gFeltProcessParentInstance.proc.pid
      }`
    );
    gFeltProcessParentInstance.logoutReported = true;

    // Send the logout request to the server.
    // Handle any errors that occur during signout gracefully,
    // i.e. report, but ignore them and proceed with the signout.
    lazy.ConsoleClient.performServerSignout()
      .catch(err => {
        lazy.log.error(`Server signout failed: ${err}`);
      })
      .finally(() => {
        // clear token data on the FELT side, then shut Firefox down
        Services.felt.clearTokens();
        Services.felt.shutdownFirefox();
        gFeltProcessParentInstance.proc.exitPromise.then(_ => {
          if (reason) {
            Services.cpmm.sendAsyncMessage(
              "FeltParent:FirefoxSessionInterrupted",
              { reason }
            );
          } else {
            Services.cpmm.sendAsyncMessage("FeltParent:FirefoxLogoutExit", {
              reason: "logout",
            });
          }
        });
      });
  }

  async receiveMessage(message) {
    lazy.log.debug(
      `ParentProcess: Received message ${message.name} => ${message.data}`
    );
    switch (message.name) {
      case "FeltChild:StartFirefox":
        {
          const {
            access_token = "",
            refresh_token = "",
            expires_in = 0,
          } = message.data;
          const expires_at = Math.floor(Date.now() / 1000) + Number(expires_in);
          Services.felt.setTokens(access_token, refresh_token, expires_at);

          // TODO: Bug 2003001 - Pass user info from Felt to Firefox to avoid network request on startup
          this.loggedInUserInfo =
            await lazy.ConsoleClient.getLoggedInUserInfo();
          lazy.FeltStorage.updateLastSignedInUserEmail(
            this.loggedInUserInfo?.email
          );

          const ssoCollectedCookies = this.getAllCookies();
          lazy.log.debug(`Collected cookies: ${ssoCollectedCookies.length}`);
          // When a restart was reported we assume cookies were stored properly on the
          // browser side?
          if (!ssoCollectedCookies.length) {
            throw new Error("Not enough cookies!!");
          }

          this.startFirefox(
            PROCESS_START_REASON.INITIAL_START,
            ssoCollectedCookies
          );
        }
        break;

      default:
        break;
    }
  }

  getAllCookies() {
    lazy.log.debug(
      `collecting cookies from privateBrowsingId=${lazy.FeltCommon.PRIVATE_BROWSING_ID}`
    );
    return Services.cookies.getCookiesWithOriginAttributes(
      JSON.stringify({
        privateBrowsingId: lazy.FeltCommon.PRIVATE_BROWSING_ID,
      })
    );
  }

  async profileName() {
    if (this.loggedInUserInfo !== null) {
      return `${lazy.FeltCommon.ENTERPRISE_PROFILE}-${await hashTo40bits(this.loggedInUserInfo.id)}`;
    }
    lazy.log.error(`loggedInUserInfo not set`);
    return lazy.FeltCommon.ENTERPRISE_PROFILE;
  }
}

async function hashTo40bits(s) {
  const msgUint8 = new TextEncoder().encode(s);
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", msgUint8);
  const base64 = new Uint8Array(hashBuffer).slice(0, 5).toBase64({
    omitPadding: true,
    alphabet: "base64url",
  });
  return base64;
}
