/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/* import-globals-from ../../../common/tests/unit/head_helpers.js */

var { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);

// Required to avoid failures.
do_get_profile();

// Init FormHistoryStartup and pretend we opened a profile.
var fhs = Cc["@mozilla.org/satchel/form-history-startup;1"].getService(
  Ci.nsIObserver
);
fhs.observe(null, "profile-after-change", null);

// An app is going to have some prefs set which xpcshell tests don't.
Services.prefs.setStringPref(
  "identity.sync.tokenserver.uri",
  "http://token-server"
);

// Enterprise builds default the passwords engine off, since syncing it requires
// an explicit local opt-in, but these tests assume the upstream default. This
// has to go on the default branch rather than be a user pref, because some
// tests clear every user pref under services.sync. between tasks.
// AppConstants is imported inline because several tests in this directory
// declare `const AppConstants` themselves, and head files share their global.
if (
  ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs")
    .AppConstants.MOZ_ENTERPRISE
) {
  const syncEngineDefaults = Services.prefs.getDefaultBranch(
    "services.sync.engine."
  );
  syncEngineDefaults.setBoolPref("passwords", true);
  registerCleanupFunction(() => {
    syncEngineDefaults.setBoolPref("passwords", false);
  });
}

// Make sure to provide the right OS so crypto loads the right binaries
function getOS() {
  switch (mozinfo.os) {
    case "win":
      return "WINNT";
    case "mac":
      return "Darwin";
    default:
      return "Linux";
  }
}

const { updateAppInfo } = ChromeUtils.importESModule(
  "resource://testing-common/AppInfo.sys.mjs"
);
updateAppInfo({
  name: "XPCShell",
  ID: "xpcshell@tests.mozilla.org",
  version: "1",
  platformVersion: "",
  OS: getOS(),
});

// Register resource aliases. Normally done in SyncComponents.manifest.
function addResourceAlias() {
  const resProt = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  for (let s of ["common", "sync", "crypto"]) {
    let uri = Services.io.newURI("resource://gre/modules/services-" + s + "/");
    resProt.setSubstitution("services-" + s, uri);
  }
}
addResourceAlias();
