/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  ConsoleClient: "resource:///modules/enterprise/ConsoleClient.sys.mjs",
  isTesting: "resource:///modules/enterprise/EnterpriseCommon.sys.mjs",
  createEnterpriseLogger:
    "resource:///modules/enterprise/EnterpriseCommon.sys.mjs",
  FeltCommon: "chrome://felt/content/FeltCommon.sys.mjs",
  FeltStorage: "resource:///modules/FeltStorage.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("FeltProcessParent");
});

const PROCESS_START_REASON = {
  INITIAL_START: "initial-start",
  RESTART: "restart",
  CRASH: "crash",
};

// Import the shared pending URLs queue
import {
  gFeltPendingURLs,
  resetFeltFirefoxWindowReady,
  FELT_OPEN_WINDOW_DISPOSITION,
} from "resource:///modules/FeltURLHandler.sys.mjs";

export function queueURL(payload) {
  // If Firefox AND extension are both ready, forward immediately
  if (
    gFeltProcessParentInstance?.firefoxReady &&
    gFeltProcessParentInstance?.extensionReady
  ) {
    gFeltProcessParentInstance.sendURLToFirefox(payload);
    // Ensure Felt launcher stays hidden when forwarding to running Firefox
    Services.felt.makeBackgroundProcess(true);
  } else {
    // Queue at module level until ready
    gFeltPendingURLs.push(payload);
  }
}

let gFeltProcessParentInstance = null;

function extractURLPayload(payload) {
  return {
    url: payload.url ?? "",
    disposition: payload.disposition ?? FELT_OPEN_WINDOW_DISPOSITION.DEFAULT,
  };
}

let gFeltFirefoxReadyNotified = false;

export function isFeltFirefoxWindowReady() {
  return (
    gFeltProcessParentInstance?.firefoxReady &&
    gFeltProcessParentInstance?.extensionReady
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
  lazy.log.debug("FeltExtension: Notifying felt-firefox-window-ready");
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
  "felt-extension-ready",
  "felt-firefox-logout",
  "felt-firefox-tokens",
];

let gObserversRegistered = false;

/**
 * Manages the SSO login and launching Firefox
 */
export class FeltProcessParent extends JSProcessActorParent {
  constructor() {
    lazy.log.debug(
      `FeltExtension: FeltParentProcess.sys.mjs: FeltProcessParent`
    );
    super();

    // Store instance globally
    gFeltProcessParentInstance = this;

    // Track Firefox ready state (URLs remain in gFeltPendingURLs until ready)
    this.firefoxReady = false;
    // Track extension ready state (extension must register its observer)
    this.extensionReady = false;
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
        lazy.log.debug(`FeltExtension: ParentProcess: Received ${aTopic}`);
        switch (aTopic) {
          case "felt-firefox-exiting": {
            gFeltProcessParentInstance.exitReported = true;
            break;
          }

          case "felt-firefox-restarting": {
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
                lazy.log.debug(
                  `FeltExtension: ParentProcess: getReadyUpdate failed: ${err}`
                );
              })
              .then(pendingUpdate => {
                lazy.log.debug(
                  `FeltExtension: ParentProcess: restart notification, restartDisabled=${restartDisabled}`
                );
                // Kill Firefox directly instead of broadcasting to receiveMessage()
                // since gFeltProcessParentInstance is accessible here
                if (gFeltProcessParentInstance?.proc) {
                  gFeltProcessParentInstance.restartReported = true;
                  gFeltProcessParentInstance.firefox = null;
                  lazy.log.debug(
                    `FeltExtension: ParentProcess: Killing Firefox PID=${gFeltProcessParentInstance.proc.pid}`
                  );
                  gFeltProcessParentInstance.proc
                    .kill()
                    .then(() => {
                      lazy.log.debug(
                        `FeltExtension: ParentProcess: Killed Firefox, restartDisabled=${restartDisabled}`
                      );

                      if (!restartDisabled && !pendingUpdate) {
                        lazy.log.debug(
                          `FeltExtension: ParentProcess: Starting new Firefox`
                        );
                        gFeltProcessParentInstance.startFirefox(
                          PROCESS_START_REASON.RESTART
                        );
                      } else if (pendingUpdate) {
                        lazy.log.debug(
                          `FeltExtension: ParentProcess: Restart requested and pending update, restarting FELT UI`
                        );
                        Services.cpmm.sendAsyncMessage(
                          "FeltParent:FirefoxRestartUpdateExit",
                          {}
                        );
                      } else {
                        lazy.log.debug(
                          `FeltExtension: ParentProcess: Restart disabled, sending normal exit to restore FELT UI`
                        );
                        Services.cpmm.sendAsyncMessage(
                          "FeltParent:FirefoxNormalExit",
                          {}
                        );
                      }
                    })
                    .catch(err => {
                      lazy.log.debug(
                        `FeltExtension: ParentProcess: Kill failed: ${err}`
                      );
                    });
                } else {
                  lazy.log.debug(
                    `FeltExtension: ParentProcess: No proc to kill!`
                  );
                }
              });
            break;
          }
          case "felt-extension-ready": {
            if (gFeltProcessParentInstance) {
              gFeltProcessParentInstance.extensionReady = true;
              gFeltProcessParentInstance.forwardPendingURLs();
              notifyFirefoxReady();
            }
            break;
          }

          case "felt-firefox-logout":
            gFeltProcessParentInstance.logoutFirefox(aData);
            break;

          case "felt-firefox-tokens": {
            lazy.log.debug(
              `FeltExtension: ParentProcess: Update tokens from browser to FELT`
            );
            const data = JSON.parse(aData);
            Services.felt.setTokens(
              data.access_token,
              data.refresh_token,
              data.expires_at
            );
            break;
          }

          default:
            lazy.log.debug(`FeltExtension: ParentProcess: Unhandled ${aTopic}`);
            break;
        }
      },
    };
  }

  sendPrefsToFirefox() {
    // Enables remote policy polling
    Services.felt.sendBoolPreference(
      "browser.policies.live_polling.enabled",
      true
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
        "browser.policies.live_polling.frequency",
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
    this.extensionReady = false;
    resetFeltFirefoxWindowReady();
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

    this.firefox = this.startFirefoxProcess();
    this.firefox
      .then(async () => {
        this.sendPrefsToFirefox();
        Services.felt.sendTokens();
        lazy.ConsoleClient.isSessionRefreshBlocked = true;

        await this._applyFirefoxConfigs();

        Services.felt.sendCookies(ssoCollectedCookies);
        Services.felt.sendReady();
        this.firefoxReady = true;

        // Try to forward pending URLs now (will only forward if extension is also ready)
        this.forwardPendingURLs();
        notifyFirefoxReady();
      })
      .then(() => {
        lazy.log.debug(
          `firefox: waiting on proc PID ${this.proc.pid}`,
          this.proc
        );

        this.proc.exitPromise
          .then(ev => {
            lazy.ConsoleClient.isSessionRefreshBlocked = false;
            lazy.log.debug(`firefox exit: ev`, JSON.stringify(ev));
            lazy.log.debug(
              `firefox exit: PID:${this.proc.pid} exitCode:${JSON.stringify(this.proc.exitCode)}`
            );

            if (!this.restartReported && !this.logoutReported) {
              if (this.proc.exitCode === 0) {
                this.abnormalExitCounter = 0;
                this.abnormalExitFirstTime = 0;
                Services.cpmm.sendAsyncMessage("FeltParent:FirefoxNormalExit", {
                  performLogout: true,
                });
              } else {
                this.handleRestartAfterAbnormalExit();
              }
            }
          })
          .finally(() => {
            lazy.ConsoleClient.isSessionRefreshBlocked = false;
          });
      })
      .catch(err => {
        lazy.ConsoleClient.isSessionRefreshBlocked = false;
        throw err;
      });
  }

  /**
   * Handles the abnormal exit and decides whether to restart the Firefox
   * again or to inform the user of the set of crashes.
   */
  handleRestartAfterAbnormalExit() {
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

    if (!profilePath) {
      let profileService = Cc[
        "@mozilla.org/toolkit/profile-service;1"
      ].getService(Ci.nsIToolkitProfileService);

      let profileName = await this.profileName();
      let foundProfile = null;

      for (let profile of profileService.profiles) {
        if (profile.name === profileName) {
          foundProfile = profile;
          break;
        }
      }

      /* Remove once we finished foxfooding */
      if (!foundProfile) {
        let legacyProfileName = lazy.FeltCommon.ENTERPRISE_PROFILE;
        for (let profile of profileService.profiles) {
          if (profile.name === legacyProfileName) {
            foundProfile = profile;
            lazy.log.warn("using legacy profile");
            break;
          }
        }
      }

      if (!foundProfile) {
        lazy.log.debug(`FeltExtension: creating new ${profileName} profile`);
        foundProfile = profileService.createProfile(null, profileName);

        await profileService.asyncFlush();
      }

      profilePath = foundProfile.rootDir.path;
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

    const firefoxRunArgs = [
      "--foreground",
      "--profile",
      profilePath,
      "-felt",
      socket,
      ...extraRunArgs,
    ];

    const firefoxRun = {
      command: firefoxBin,
      arguments: firefoxRunArgs,
      stdout: "stdout",
      stderr: "stderr",
      /* environmentAppend: true,
      environment: env, */
    };

    try {
      this.proc = await lazy.Subprocess.call(firefoxRun);
    } catch (e) {
      lazy.log.error("Failed to launch Firefox: ", e.message);
      throw e;
    }

    Services.felt.ipcChannel();
  }

  /**
   * Send a URL request to Firefox via IPC (Firefox must be ready)
   *
   * @param {object} payload - Object with url and disposition properties
   */
  sendURLToFirefox(payload) {
    if (!this.firefoxReady || !Services.felt) {
      lazy.log.error(`FeltExtension: Cannot send URL, Firefox not ready`);
      return;
    }

    try {
      let { url, disposition } = extractURLPayload(payload);
      Services.felt.openURL(url, disposition);
    } catch (err) {
      lazy.log.error(`FeltExtension: Failed to forward URL: ${err}`);
    }
  }

  /**
   * Forward all pending URLs to Firefox
   */
  forwardPendingURLs() {
    if (gFeltPendingURLs.length === 0) {
      return;
    }

    // Wait for both Firefox (prefs/cookies) AND extension (observer) to be ready
    if (!this.firefoxReady || !this.extensionReady) {
      lazy.log.debug(
        `FeltExtension: Not ready to forward URLs (firefoxReady=${this.firefoxReady}, extensionReady=${this.extensionReady})`
      );
      return;
    }

    if (!Services.felt) {
      lazy.log.error(
        `FeltExtension: Services.felt not available, cannot forward URLs`
      );
      return;
    }

    // Forward all URLs directly via IPC (both Firefox and extension are ready)
    for (const payload of gFeltPendingURLs) {
      try {
        let { url, disposition } = extractURLPayload(payload);
        Services.felt.openURL(url, disposition);
      } catch (err) {
        lazy.log.error(`FeltExtension: Failed to forward URL: ${err}`);
      }
    }

    // Clear the queue
    gFeltPendingURLs.length = 0;
  }

  /**
   * Perform all the logout operations on FELT side.
   *
   * @param {string} logoutType - One of the logout type payload strings from the IPC message.
   */
  logoutFirefox(logoutType) {
    if (!Services.felt.isFeltUI()) {
      throw new Error("Logout handling should only happen on FELT side.");
    }

    lazy.log.debug(
      `FeltExtension: Logout (${logoutType}), waiting on ${gFeltProcessParentInstance.proc.pid}`
    );
    gFeltProcessParentInstance.logoutReported = true;
    lazy.ConsoleClient.clearTokenData();

    // Ensure that things are cleared
    const ssoCollectedCookies = gFeltProcessParentInstance.getAllCookies();
    if (ssoCollectedCookies.length) {
      throw new Error("Too many cookies!!");
    }

    gFeltProcessParentInstance.proc.exitPromise.then(_ => {
      Services.cpmm.sendAsyncMessage("FeltParent:FirefoxLogoutExit", {
        logoutType,
      });
    });
  }

  async receiveMessage(message) {
    lazy.log.debug(
      `FeltExtension: ParentProcess: Received message ${message.name} => ${message.data}`
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
      `FeltExtension: collecting cookies from privateBrowsingId=${lazy.FeltCommon.PRIVATE_BROWSING_ID}`
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
    lazy.log.error(`FeltExtension: loggedInUserInfo not set`);
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
