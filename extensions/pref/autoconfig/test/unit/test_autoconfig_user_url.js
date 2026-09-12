/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// On an enterprise build a profile's user.js cannot point AutoConfig at
// another file through autoadmin.global_config_url. Once the shipped
// firefox.cfg has been evaluated the remaining AutoConfig inputs are never
// consulted, so the user-set URL is never fetched.

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

function run_test() {
  if (!AppConstants.MOZ_ENTERPRISE) {
    info("Skipping on non-enterprise build (MOZ_ENTERPRISE is not set)");
    ok(true, "skipped: not an enterprise build");
    return;
  }

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

  // nsAutoConfig would fetch the remote file on this notification.
  Services.obs.notifyObservers(null, "profile-after-change");
  ok(
    !prefs.prefHasUserValue("_autoconfig_.test.remote"),
    "a user-set autoadmin.global_config_url is not fetched"
  );

  Services.prefs.resetPrefs();
}
