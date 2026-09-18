/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// The AutoConfig file can still set the vendor with plain pref(), since only
// values present before it is evaluated, i.e. from the profile, are dropped.
// The AutoConfig URL is only honored as a default pref: pref() in the
// AutoConfig file is dropped, defaultPref() works.

const REMOTE_ENV = "AUTOCONFIG_TEST_REMOTE_URL";

function run_test() {
  let prefs = Services.prefs.getBranch(null);

  let greD = Services.dirsvc.get("GreD", Ci.nsIFile);
  let defaultPrefD = Services.dirsvc.get("PrfDef", Ci.nsIFile);
  let testDir = do_get_cwd();

  let autoConfigJS = testDir.clone();
  autoConfigJS.append("autoconfig.js");
  autoConfigJS.copyTo(defaultPrefD, "autoconfig.js");

  let installedCfg = greD.clone();
  installedCfg.append("autoconfig.cfg");

  function installCfg(name) {
    if (installedCfg.exists()) {
      installedCfg.remove(false);
    }
    let cfg = testDir.clone();
    cfg.append(name);
    cfg.copyTo(greD, "autoconfig.cfg");
  }

  registerCleanupFunction(() => {
    for (let [dir, name] of [
      [defaultPrefD, "autoconfig.js"],
      [greD, "autoconfig.cfg"],
    ]) {
      let file = dir.clone();
      file.append(name);
      if (file.exists()) {
        file.remove(false);
      }
    }
    Services.env.set(REMOTE_ENV, "");
    Services.prefs.resetPrefs();
  });

  let remoteCfg = testDir.clone();
  remoteCfg.append("autoconfig-remote.jsc");
  let remoteUrl = Services.io.newFileURI(remoteCfg).spec;
  Services.env.set(REMOTE_ENV, remoteUrl);

  // Make sure nsReadConfig is initialized.
  Cc["@mozilla.org/readconfig;1"].getService(Ci.nsISupports);

  // Phase 1: pref() in the AutoConfig file does not set the URL. This runs
  // first so that no nsAutoConfig instance exists yet.
  Services.prefs.resetPrefs();
  installCfg("autoconfig-admin-url-pref.cfg");

  Services.obs.notifyObservers(
    Services.prefs,
    "prefservice:before-read-userprefs"
  );

  equal(
    "cfg",
    prefs.getStringPref("_autoconfig_.test.admin"),
    "the administrator's AutoConfig file is applied"
  );
  ok(
    !prefs.prefHasUserValue("autoadmin.global_config_url"),
    "a URL set with pref() in the AutoConfig file is dropped"
  );

  // nsAutoConfig would fetch the remote file on this notification.
  Services.obs.notifyObservers(null, "profile-after-change");
  ok(
    !prefs.prefHasUserValue("_autoconfig_.test.remote"),
    "a URL set with pref() in the AutoConfig file is not fetched"
  );

  // Phase 2: pref() sets the vendor and defaultPref() sets the URL, with
  // hostile profile values present for both.
  Services.prefs.resetPrefs();
  installCfg("autoconfig-admin-pref.cfg");
  prefs.setStringPref("general.config.vendor", "notautoconfig");
  prefs.setStringPref("autoadmin.global_config_url", "file:///nonexistent.jsc");

  Services.obs.notifyObservers(
    Services.prefs,
    "prefservice:before-read-userprefs"
  );

  equal(
    "autoconfig",
    prefs.getStringPref("general.config.vendor"),
    "pref() in the AutoConfig file sets the vendor"
  );
  equal(
    remoteUrl,
    Services.prefs
      .getDefaultBranch(null)
      .getStringPref("autoadmin.global_config_url"),
    "defaultPref() in the AutoConfig file sets the remote URL"
  );
  ok(
    !prefs.prefHasUserValue("autoadmin.global_config_url"),
    "the profile-set URL is dropped"
  );

  // nsAutoConfig fetches the URL on this notification.
  Services.obs.notifyObservers(null, "profile-after-change");
  equal(
    "remote",
    prefs.getStringPref("_autoconfig_.test.remote"),
    "the remote AutoConfig file set with defaultPref() is fetched"
  );
}
