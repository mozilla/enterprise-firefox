/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  ConsoleClient: "chrome://felt/content/ConsoleClient.sys.mjs",
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
              "browser.felt.disable_restart",
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

  startFirefox(accessToken = null) {
    this.restartReported = false;
    Services.cpmm.sendAsyncMessage("FeltParent:FirefoxStarting", {});
    this.firefox = this.startFirefoxProcess();
    this.firefox
      .then(async () => {
        const consoleAddr = lazy.ConsoleClient.consoleAddr;
        Services.felt.sendStringPreference("browser.felt.console", consoleAddr);
        Services.felt.sendStringPreference(
          "browser.policies.server",
          consoleAddr
        );

        if (accessToken) {
          Services.felt.sendStringPreference(
            "browser.policies.access_token",
            accessToken
          );
        }
        const json = await lazy.ConsoleClient.getDefaultPrefs();
        json.prefs.forEach(pref => {
          const name = pref[0];
          const value = pref[1];

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

        Services.felt.sendCookies(this.getAllCookies());
        Services.felt.sendReady();
        Services.cpmm.sendAsyncMessage("FeltParent:FirefoxStarted", {});
      })
      .then(() => {
        console.debug(
          `firefox: waiting on proc PID ${this.proc.pid}`,
          this.proc
        );
        // console.debug(`Starting 30s timeout to show about:restartforeced`);
        // lazy.setTimeout(() => {
        //   console.debug(`Triggered 30s timeout to show about:restartforeced`);
        //   Services.felt.sendRestartForced();
        // }, 30 * 1000);

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
      "browser.felt.profile_path",
      ""
    );

    if (!profilePath) {
      let profileService = Cc[
        "@mozilla.org/toolkit/profile-service;1"
      ].getService(Ci.nsIToolkitProfileService);

      let foundProfile = null;
      for (let profile of profileService.profiles) {
        if (profile.name === lazy.ConsoleClient.ENTERPRISE_PROFILE) {
          foundProfile = profile;
          break;
        }
      }

      if (!foundProfile) {
        console.debug(
          `FeltExtension: creating new ${lazy.ConsoleClient.ENTERPRISE_PROFILE} profile`
        );
        foundProfile = profileService.createProfile(
          null,
          lazy.ConsoleClient.ENTERPRISE_PROFILE
        );

        await profileService.asyncFlush();
      }

      profilePath = foundProfile.rootDir.path;
    }

    let extraRunArgs = [];
    if (Services.prefs.getBoolPref("browser.felt.is_testing", false)) {
      extraRunArgs = [
        "--marionette",
        "--remote-allow-hosts",
        "localhost",
        "--remote-allow-system-access",
      ];
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

    this.proc = await lazy.Subprocess.call(firefoxRun)
      .then(proc => {
        return proc;
      })
      .catch(err => {
        console.error(err instanceof Error ? err : err.message);
      });

    Services.felt.ipcChannel();
  }

  receiveMessage(message) {
    console.debug(
      `FeltExtension: ParentProcess: Received message ${message.name} => ${message.data}`
    );
    switch (message.name) {
      case "FeltChild:StartFirefox":
        this.startFirefox(message.data?.access_token ?? null);
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
    return Services.cookies.cookies;
  }
}
