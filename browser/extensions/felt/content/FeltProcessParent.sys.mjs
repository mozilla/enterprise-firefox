/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  ConsoleClient: "resource:///modules/enterprise/ConsoleClient.sys.mjs",
  PREFS: "resource:///modules/enterprise/ConsoleClient.sys.mjs",
  isTesting: "resource:///modules/enterprise/EnterpriseCommon.sys.mjs",
  FeltCommon: "chrome://felt/content/FeltCommon.sys.mjs",
});

console.debug(`FeltExtension: FeltParentProcess.sys.mjs`);

// Import the shared pending URLs queue from BrowserContentHandler
// This queue is shared between BrowserContentHandler (which fills it early during command-line
// processing) and FeltProcessParent (which forwards URLs after Firefox is ready)
import { gFeltPendingURLs } from "resource:///modules/BrowserContentHandler.sys.mjs";

export function queueURL(url) {
  // If Firefox AND extension are both ready, forward immediately
  if (
    gFeltProcessParentInstance?.firefoxReady &&
    gFeltProcessParentInstance?.extensionReady
  ) {
    gFeltProcessParentInstance.sendURLToFirefox(url);
    // Ensure Felt launcher stays hidden when forwarding to running Firefox
    Services.felt.makeBackgroundProcess(true);
  } else {
    // Queue at module level until ready
    gFeltPendingURLs.push(url);
  }
}

let gFeltProcessParentInstance = null;

/**
 * Manages the SSO login and launching Firefox
 */
export class FeltProcessParent extends JSProcessActorParent {
  constructor() {
    console.debug(
      `FeltExtension: FeltParentProcess.sys.mjs: FeltProcessParent`
    );
    super();

    // Store instance globally
    gFeltProcessParentInstance = this;

    // Track Firefox ready state (URLs remain in gFeltPendingURLs until ready)
    this.firefoxReady = false;
    // Track extension ready state (extension must register its observer)
    this.extensionReady = false;

    this.restartObserver = {
      observe(aSubject, aTopic) {
        console.debug(`FeltExtension: ParentProcess: Received ${aTopic}`);
        switch (aTopic) {
          case "felt-firefox-restarting": {
            const restartDisabled = Services.prefs.getBoolPref(
              "enterprise.disable_restart",
              false
            );
            console.debug(
              `FeltExtension: ParentProcess: restart notification, restartDisabled=${restartDisabled}`
            );
            // Kill Firefox directly instead of broadcasting to receiveMessage()
            // since gFeltProcessParentInstance is accessible here
            if (gFeltProcessParentInstance?.proc) {
              gFeltProcessParentInstance.restartReported = true;
              gFeltProcessParentInstance.firefox = null;
              console.debug(
                `FeltExtension: ParentProcess: Killing Firefox PID=${gFeltProcessParentInstance.proc.pid}`
              );
              gFeltProcessParentInstance.proc
                .kill()
                .then(() => {
                  console.debug(
                    `FeltExtension: ParentProcess: Killed Firefox, restartDisabled=${restartDisabled}`
                  );
                  if (!restartDisabled) {
                    console.debug(
                      `FeltExtension: ParentProcess: Starting new Firefox`
                    );
                    gFeltProcessParentInstance.startFirefox();
                  } else {
                    console.debug(
                      `FeltExtension: ParentProcess: Restart disabled, sending normal exit to restore FELT UI`
                    );
                    Services.cpmm.sendAsyncMessage(
                      "FeltParent:FirefoxNormalExit",
                      {}
                    );
                  }
                })
                .catch(err => {
                  console.debug(
                    `FeltExtension: ParentProcess: Kill failed: ${err}`
                  );
                });
            } else {
              console.debug(`FeltExtension: ParentProcess: No proc to kill!`);
            }
            break;
          }
          case "felt-extension-ready": {
            if (gFeltProcessParentInstance) {
              gFeltProcessParentInstance.extensionReady = true;
              gFeltProcessParentInstance.forwardPendingURLs();
            }
            break;
          }
          case "felt-firefox-logout":
            gFeltProcessParentInstance.logoutFirefox();
            break;

          default:
            console.debug(`FeltExtension: ParentProcess: Unhandled ${aTopic}`);
            break;
        }
      },
    };

    Services.obs.addObserver(this.restartObserver, "felt-firefox-restarting");
    Services.obs.addObserver(this.restartObserver, "felt-extension-ready");
    Services.obs.addObserver(this.restartObserver, "felt-firefox-logout");
  }

  sanitizePrefs(prefs) {
    let sanitized = [];
    prefs?.forEach(pref => {
      const name = JSON.stringify(pref[0]);
      console.debug(`Felt: sanitizePrefs() ${pref[0]} => ${name})`);
      let value = pref[1];
      switch (typeof pref[1]) {
        case "string":
          value = JSON.stringify(value);
          break;

        case "boolean":
          break;

        case "number":
          if (!Number.isInteger(pref[1])) {
            value = `"${pref[1]}"`;
          } else {
            value = Number(pref[1]);
          }
          break;

        default:
          console.warn(`Pref ${pref[0]} with value '${pref[1]}' not valid`);
          value = null;
          break;
      }

      if (value !== null) {
        sanitized.push([name, value]);
      }
    });
    return sanitized;
  }

  sendPrefsToFirefox() {
    Services.felt.sendStringPreference(
      lazy.PREFS.CONSOLE_ADDRESS,
      lazy.ConsoleClient.consoleBaseURI
    );
    Services.felt.sendBoolPreference(
      "browser.policies.live_polling.enabled",
      true
    );
    Services.felt.sendIntPreference(
      "browser.policies.live_polling.frequency",
      lazy.FeltCommon.POLICY_POLLING_FREQUENCY
    );
  }

  async startFirefox(ssoCollectedCookies = []) {
    this.restartReported = false;
    this.logoutReported = false;
    this.firefoxReady = false;
    this.extensionReady = false;
    Services.cpmm.sendAsyncMessage("FeltParent:FirefoxStarting", {});
    this.firefox = this.startFirefoxProcess();
    this.firefox
      .then(async () => {
        this.sendPrefsToFirefox();
        Services.felt.sendTokens();
        const { prefs } = await lazy.ConsoleClient.getDefaultPrefs();
        prefs.forEach(pref => {
          const name = pref[0];
          const value = pref[1];

          console.debug(`Felt: Services.felt(${name}, ${value})`);

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
          }
        });

        Services.felt.sendCookies(ssoCollectedCookies);
        Services.felt.sendReady();
        this.firefoxReady = true;

        // Try to forward pending URLs now (will only forward if extension is also ready)
        this.forwardPendingURLs();
      })
      .then(() => {
        console.debug(
          `firefox: waiting on proc PID ${this.proc.pid}`,
          this.proc
        );

        this.proc.exitPromise.then(ev => {
          console.debug(`firefox exit: ev`, JSON.stringify(ev));
          console.debug(
            `firefox exit: PID:${this.proc.pid} exitCode:${JSON.stringify(this.proc.exitCode)}`
          );
          if (!this.restartReported && !this.logoutReported) {
            if (this.proc.exitCode === 0) {
              Services.cpmm.sendAsyncMessage(
                "FeltParent:FirefoxNormalExit",
                {}
              );
            } else {
              Services.cpmm.sendAsyncMessage(
                "FeltParent:FirefoxAbnormalExit",
                {}
              );
            }
          }
        });
      });
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

      let foundProfile = null;
      for (let profile of profileService.profiles) {
        if (profile.name === lazy.FeltCommon.ENTERPRISE_PROFILE) {
          foundProfile = profile;
          break;
        }
      }

      if (!foundProfile) {
        console.debug(
          `FeltExtension: creating new ${lazy.FeltCommon.ENTERPRISE_PROFILE} profile`
        );
        foundProfile = profileService.createProfile(
          null,
          lazy.FeltCommon.ENTERPRISE_PROFILE
        );

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

    const prefsJsFile = PathUtils.join(profilePath, "prefs.js");
    let prefsJsContent = "";
    if (await IOUtils.exists(prefsJsFile)) {
      prefsJsContent = await IOUtils.readUTF8(prefsJsFile);
    }

    const startupPrefs = (await lazy.ConsoleClient.getStartupPrefs()).prefs;
    this.sanitizePrefs(startupPrefs).forEach(pref => {
      prefsJsContent += `\nuser_pref(${pref[0]}, ${pref[1]});`;
    });
    prefsJsContent += "\n";

    await IOUtils.writeUTF8(prefsJsFile, prefsJsContent);

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
      console.error("Failed to launch Firefox: ", e.message);
      throw e;
    }

    Services.felt.ipcChannel();
  }

  /**
   * Send a URL to Firefox via IPC (Firefox must be ready)
   *
   * @param {string} url
   */
  sendURLToFirefox(url) {
    if (!this.firefoxReady || !Services.felt) {
      console.error(`FeltExtension: Cannot send URL, Firefox not ready`);
      return;
    }

    try {
      Services.felt.openURL(url);
    } catch (err) {
      console.error(`FeltExtension: Failed to forward URL: ${err}`);
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
      console.debug(
        `FeltExtension: Not ready to forward URLs (firefoxReady=${this.firefoxReady}, extensionReady=${this.extensionReady})`
      );
      return;
    }

    if (!Services.felt) {
      console.error(
        `FeltExtension: Services.felt not available, cannot forward URLs`
      );
      return;
    }

    // Forward all URLs directly via IPC (both Firefox and extension are ready)
    for (const url of gFeltPendingURLs) {
      try {
        Services.felt.openURL(url);
      } catch (err) {
        console.error(`FeltExtension: Failed to forward URL ${url}: ${err}`);
      }
    }

    // Clear the queue
    gFeltPendingURLs.length = 0;
  }

  /**
   * Perform all the logout operations on FELT side
   */
  logoutFirefox() {
    if (!Services.felt.isFeltUI()) {
      throw new Error("Logout handling should only happen on FELT side.");
    }

    console.debug(
      `FeltExtension: Logout, waiting on ${gFeltProcessParentInstance.proc.pid}`
    );
    gFeltProcessParentInstance.logoutReported = true;
    lazy.ConsoleClient.clearTokenData();

    // Ensure that things are cleared
    const ssoCollectedCookies = gFeltProcessParentInstance.getAllCookies();
    if (ssoCollectedCookies.length) {
      throw new Error("Too many cookies!!");
    }

    gFeltProcessParentInstance.proc.exitPromise.then(_ => {
      Services.cpmm.sendAsyncMessage("FeltParent:FirefoxLogoutExit", {});
    });
  }

  receiveMessage(message) {
    console.debug(
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
          Services.felt.setTokens(access_token, refresh_token, expires_in);

          const ssoCollectedCookies = this.getAllCookies();
          console.debug(`Collected cookies: ${ssoCollectedCookies.length}`);
          // When a restart was reported we assume cookies were stored properly on the
          // browser side?
          if (!ssoCollectedCookies.length) {
            throw new Error("Not enough cookies!!");
          }

          this.startFirefox(ssoCollectedCookies);
        }
        break;

      default:
        break;
    }
  }

  getAllCookies() {
    console.debug(
      `FeltExtension: collecting cookies from privateBrowsingId=${lazy.FeltCommon.PRIVATE_BROWSING_ID}`
    );
    return Services.cookies.getCookiesWithOriginAttributes(
      JSON.stringify({
        privateBrowsingId: lazy.FeltCommon.PRIVATE_BROWSING_ID,
      })
    );
  }
}
