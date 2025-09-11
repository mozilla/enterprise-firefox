/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  FeltCommon: "chrome://felt/content/FeltCommon.sys.mjs",
});

console.debug(`FeltExtension: FeltParentProcess.sys.mjs`);

export class FeltProcessParent extends JSProcessActorParent {
  constructor() {
    console.debug(`FeltExtension: FeltParentProcess.sys.mjs: FeltProcessParent`);
    super();
    this.felt = Cc["@mozilla.org/toolkit/library/felt;1"].getService(
      Ci.nsIFelt
    );

    this.restartObserver = {
      observe(aSubject, aTopic, aData) {
        console.debug(`FeltExtension: ParentProcess: Received ${aTopic}`);
        switch (aTopic) {
          case "felt-firefox-restarting":
	    const restartDisabled = Services.prefs.getBoolPref("browser.felt.disable_restart", false);
            if (!restartDisabled) {
                Services.ppmm.broadcastAsyncMessage("FeltParent:RestartFirefox", {});
	    } else {
                console.debug(`FeltExtension: ParentProcess: restart is disabled`);
	    }
            break;

          default:
            console.debug(`FeltExtension: ParentProcess: Unhandled ${aTopic}`);
            break;
        }
      },
    };

    this._logger = lazy.FeltCommon.defineLogGetter("FeltParent");

    Services.cpmm.addMessageListener("FeltParent:RestartFirefox", this);
    Services.obs.addObserver(this.restartObserver, "felt-firefox-restarting");
  }

  startFirefox() {
    this.restartReported = false;
    this.firefox = this.startFirefoxProcess();
    this.firefox
      .then(async () => {
        const consoleAddr = Services.prefs.getStringPref(
          "browser.felt.console"
        );
        this.felt.sendStringPreference("browser.felt.console", consoleAddr);
        this.felt.sendStringPreference("browser.policies.server", consoleAddr);

        const json = await (await await fetch(`${consoleAddr}/default`)).json();
        json.prefs.forEach(pref => {
          const name = pref[0];
          const value = pref[1];

          switch (typeof value) {
            case "boolean":
              this.felt.sendBoolPreference(name, value);
              break;

            case "string":
              this.felt.sendStringPreference(name, value);
              break;

            case "number":
              this.felt.sendIntPreference(name, value);
              break;
          }
        });
        this.felt.sendCookies(this.getAllCookies());
        this.felt.sendReady();
        Services.ppmm.broadcastAsyncMessage("FeltParent:Done", {});
        Services.cpmm.sendAsyncMessage("FeltParent:FirefoxStarted", {});
      })
      .then(() => {
        console.debug(
          `firefox: waiting on proc PID ${this.proc.pid}`,
          this.proc
        );
        /*
      console.debug(`Starting 30s timeout to show about:restartforeced`);
      lazy.setTimeout(() => {
        console.debug(`Triggered 30s timeout to show about:restartforeced`);
        this.felt.sendRestartForced();
      }, 30 * 1000);
*/

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

  getProfileArgs() {
    try {
      const profilePath = Services.prefs.getStringPref(
        "browser.felt.profile_path"
      );
      console.debug(`Felt: profilePath=${profilePath}`);
      return ["--profile", profilePath];
    } catch {
      return ["-P", "enterprise-profile"];
    }
  }

  startFirefoxProcess() {
    return new Promise(async (resolve, reject) => {
      let socket = this.felt.oneShotIpcServer();

      const firefoxBin = this.felt.binPath();

      try {
        Services.prefs.getStringPref("browser.felt.profile_path");
      } catch {
        const firefoxCreateProfileArgs = [
          "-no-remote",
          "-createprofile",
          "enterprise-profile",
        ];

        const firefoxCreateProfile = {
          command: firefoxBin,
          arguments: firefoxCreateProfileArgs,
          stdout: "stdout",
          stderr: "stderr",
        };

        let profileCreation = await lazy.Subprocess.call(firefoxCreateProfile)
          .then(async proc => {
            await proc.exitPromise;
            return proc.exitCode === 0;
          })
          .catch(err => {
            console.error(err instanceof Error ? err : err.message);
            return false;
          });

        if (!profileCreation) {
          console.debug(`startFirefox(): profileCreation failed`);
          reject();
          return;
        }
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

      const firefoxRunArgs = ["-no-remote", "-felt", socket].concat(
        this.getProfileArgs().concat(extraRunArgs)
      );

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

      this.felt.ipcChannel();
      resolve();
    });
  }

  receiveMessage(message) {
    console.debug(`FeltExtension: ParentProcess: Received message ${message.name} => ${message.data}`);
    switch (message.name) {
      case "FeltChild:StartFirefox":
        this.startFirefox();
        break;

      case "FeltParent:RestartFirefox":
        this.restartReported = true;
        this.firefox = null;
        console.debug(`FeltExtension: ParentProcess: Killing firefox`);
        this.proc
          .kill()
          .then(() => {
            console.debug(`FeltExtension: ParentProcess: Killed, starting new firefox`);
            this.startFirefox();
          })
          .catch(err => {
            console.debug(`FeltExtension: ParentProcess: Killed failed: ${err}`);
          });
        break;

      default:
        break;
    }
  }

  getAllCookies() {
    let cookieManager = Cc["@mozilla.org/cookiemanager;1"].getService(
      Ci.nsICookieManager
    );
    return cookieManager.cookies;
  }
}
