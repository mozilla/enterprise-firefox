/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// To prevent the administrator's configuration from being disarmed, a
// profile's user.js should not be able to make the AutoConfig vendor check
// fail through general.config.vendor or general.config.filename. nsReadConfig
// drops the profile's values before evaluating the AutoConfig file.

function run_test() {
  let prefs = Services.prefs.getBranch(null);
  let defPrefs = Services.prefs.getDefaultBranch(null);

  let greD = Services.dirsvc.get("GreD", Ci.nsIFile);
  let defaultPrefD = Services.dirsvc.get("PrfDef", Ci.nsIFile);
  let testDir = do_get_cwd();

  let autoConfigJS = testDir.clone();
  autoConfigJS.append("autoconfig.js");
  autoConfigJS.copyTo(defaultPrefD, "autoconfig.js");

  let autoConfigCfg = testDir.clone();
  autoConfigCfg.append("autoconfig-admin.cfg");
  autoConfigCfg.copyTo(greD, "autoconfig.cfg");

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
  });

  // Make sure nsReadConfig is initialized.
  Cc["@mozilla.org/readconfig;1"].getService(Ci.nsISupports);
  Services.prefs.resetPrefs();

  let remoteCfg = testDir.clone();
  remoteCfg.append("autoconfig-remote.jsc");

  // An administrator-configured remote AutoConfig file.
  defPrefs.setStringPref(
    "autoadmin.global_config_url",
    Services.io.newFileURI(remoteCfg).spec
  );
  // What a hostile user.js would set.
  prefs.setStringPref("general.config.vendor", "notautoconfig");
  prefs.setStringPref("general.config.filename", "notautoconfig.cfg");

  Services.obs.notifyObservers(
    Services.prefs,
    "prefservice:before-read-userprefs"
  );

  equal(
    "cfg",
    prefs.getStringPref("_autoconfig_.test.admin"),
    "the administrator's AutoConfig file is applied"
  );

  // nsAutoConfig fetches the admin URL on this notification.
  Services.obs.notifyObservers(null, "profile-after-change");
  equal(
    "remote",
    prefs.getStringPref("_autoconfig_.test.remote"),
    "the administrator's remote AutoConfig is fetched despite the user-set vendor"
  );

  Services.prefs.resetPrefs();
}
