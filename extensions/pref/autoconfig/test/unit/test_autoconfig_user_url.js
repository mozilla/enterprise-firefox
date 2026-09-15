/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// To prevent the administrator's configuration from being redirected, a
// profile's user.js should not be able to point AutoConfig at another file
// through autoadmin.global_config_url. The URL is only honored as a default
// pref, so the user-set URL is never fetched.

function run_test() {
  let prefs = Services.prefs.getBranch(null);

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

  // What a hostile user.js would set.
  prefs.setStringPref(
    "autoadmin.global_config_url",
    Services.io.newFileURI(remoteCfg).spec
  );

  Services.obs.notifyObservers(
    Services.prefs,
    "prefservice:before-read-userprefs"
  );

  equal(
    "cfg",
    prefs.getStringPref("_autoconfig_.test.admin"),
    "the shipped AutoConfig file is applied"
  );
  ok(
    !prefs.prefHasUserValue("autoadmin.global_config_url"),
    "the user-set autoadmin.global_config_url is dropped"
  );

  // nsAutoConfig would fetch the remote file on this notification.
  Services.obs.notifyObservers(null, "profile-after-change");
  ok(
    !prefs.prefHasUserValue("_autoconfig_.test.remote"),
    "a user-set autoadmin.global_config_url is not fetched"
  );

  Services.prefs.resetPrefs();
}
