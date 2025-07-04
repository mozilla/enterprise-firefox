/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
});

export class FeltParent extends JSWindowActorParent {
  constructor() {
    super();
    this.felt = Cc["@mozilla.org/toolkit/library/felt;1"].getService(
      Ci.nsIFelt
    );

    this.restartObserver = {
      observe(aSubject, aTopic, aData) {
        console.debug(`FELT: Received ${aTopic}`);
        switch (aTopic) {
          case "felt-firefox-restarting":
            Services.ppmm.broadcastAsyncMessage("FeltParent:RestartFirefox", {});
            break;
    
          default:
            console.debug(`FELT: Unhandled ${aTopic}`);
            break;
        }
      }
    };

    Services.cpmm.addMessageListener("FeltParent:RestartFirefox", this);
    Services.obs.addObserver(this.restartObserver, "felt-firefox-restarting");
  }

  startFirefox() {
    this.restartReported = false;
    this.firefox = this.startFirefoxProcess();
    this.firefox.then(() => {
      this.felt.sendStringPreference("browser.felt.console", Services.prefs.getStringPref("browser.felt.console"));
      this.felt.sendCookies(this.getAllCookies());
      this.felt.sendReady();
      Services.cpmm.sendAsyncMessage("FeltParent:FirefoxStarted", {});
    }).then(() => {
      const prefs = JSON.parse(this.felt.getPrefs()).prefs;
      prefs.forEach(pref => {
        const name = pref[0];
        let value = pref[1];
        if (value === "true" || value === "false") {
          value = value === "true" ? true : false;
        }

        switch (typeof(value)) {
          case "boolean":
            this.felt.sendBoolPreference(name, value);
            break;

          case "string":
            this.felt.sendStringPreference(name, value);
            break;
        }
      });
    }).then(() => {
      console.debug(`firefox: waiting on proc PID ${this.proc.pid}`, this.proc);

      console.debug(`Starting 30s timeout to show about:restartforeced`);
      lazy.setTimeout(() => {
        console.debug(`Triggered 30s timeout to show about:restartforeced`);
        this.felt.sendRestartForced();
      }, 30 * 1000);

      this.proc.exitPromise.then((ev) => {
        console.debug(`firefox exit: ev`, JSON.stringify(ev));
        console.debug(`firefox exit: exitCode`, JSON.stringify(this.proc.exitCode));
        if (!this.restartReported) {
          if (this.proc.exitCode === 0) {
            Services.cpmm.sendAsyncMessage("FeltParent:FirefoxNormalExit", {});
          } else {
            Services.cpmm.sendAsyncMessage("FeltParent:FirefoxAbnormalExit", {});
  	  }
        }
      });
    });
  }

  startFirefoxProcess() {
    return new Promise(async (resolve, reject) => {
      let socket = this.felt.oneShotIpcServer();

      const firefoxBin = this.felt.binPath();

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

      const firefoxRunArgs = [
        "-no-remote",
        "-P",
        "enterprise-profile",
        "-felt",
        socket,
        "https://sso.mozilla.com/",
      ];

      const firefoxRun = {
        command: firefoxBin,
        arguments: firefoxRunArgs,
        stdout: "stdout",
        stderr: "stderr",
        // environmentAppend: true,
        // environment: env,
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
    console.debug(`FELT: Received message ${message.name} => ${message.data}`);
    switch (message.name) {
      case "FeltChild:StartFirefox":
        this.startFirefox();
        break;

      case "FeltParent:RestartFirefox":
        this.restartReported = true;
        this.firefox = null;
        console.debug(`FELT: Killing firefox`);
        this.proc.kill()
          .then(() => {
            console.debug(`FELT: Killed, starting new firefox`);
            this.startFirefox();
          })
          .catch((err) => {
            console.debug(`FELT: Killed failed: ${err}`);
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
