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

/**
 * Manages the SSO login and launching Firefox
 */
export class FeltProcessParent extends JSProcessActorParent {
  constructor() {
    console.debug(
      `FeltExtension: FeltParentProcess.sys.mjs: FeltProcessParent`
    );
    super();

    this.restartObserver = {
      observe(aSubject, aTopic) {
        console.debug(`FeltExtension: ParentProcess: Received ${aTopic}`);
        switch (aTopic) {
          case "felt-firefox-restarting": {
            const restartDisabled = Services.prefs.getBoolPref(
              "enterprise.disable_restart",
              false
            );
            if (!restartDisabled) {
              Services.ppmm.broadcastAsyncMessage(
                "FeltParent:RestartFirefox",
                {}
              );
            } else {
              console.debug(
                `FeltExtension: ParentProcess: restart is disabled`
              );
            }
            break;
          }
          default:
            console.debug(`FeltExtension: ParentProcess: Unhandled ${aTopic}`);
            break;
        }
      },
    };

    Services.cpmm.addMessageListener("FeltParent:RestartFirefox", this);
    Services.obs.addObserver(this.restartObserver, "felt-firefox-restarting");
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
    Services.felt.sendStringPreference(
      lazy.PREFS.REFRESH_TOKEN,
      lazy.ConsoleClient.tokenData.refreshToken
    );
    Services.felt.sendBoolPreference(
      "browser.policies.live_polling.enabled",
      true
    );
  }

  async startFirefox(ssoCollectedCookies = []) {
    this.restartReported = false;
    Services.cpmm.sendAsyncMessage("FeltParent:FirefoxStarting", {});
    this.firefox = this.startFirefoxProcess();
    this.firefox
      .then(async () => {
        this.sendPrefsToFirefox();
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
      })
      .then(() => {
        console.debug(
          `firefox: waiting on proc PID ${this.proc.pid}`,
          this.proc
        );

        this.proc.exitPromise.then(ev => {
          console.debug(`firefox exit: ev`, JSON.stringify(ev));
          console.debug(
            `firefox exit: exitCode`,
            JSON.stringify(this.proc.exitCode)
          );
          if (!this.restartReported) {
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

  receiveMessage(message) {
    console.debug(
      `FeltExtension: ParentProcess: Received message ${message.name} => ${message.data}`
    );
    switch (message.name) {
      case "FeltChild:StartFirefox":
        {
          lazy.ConsoleClient.ensureTokenData(message.data);

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

      case "FeltParent:RestartFirefox":
        this.restartReported = true;
        this.firefox = null;
        console.debug(`FeltExtension: ParentProcess: Killing firefox`);
        this.proc
          .kill()
          .then(() => {
            console.debug(
              `FeltExtension: ParentProcess: Killed, starting new firefox`
            );
            this.startFirefox();
          })
          .catch(err => {
            console.debug(
              `FeltExtension: ParentProcess: Killed failed: ${err}`
            );
          });
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
