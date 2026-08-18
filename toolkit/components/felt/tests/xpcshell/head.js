/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// FeltStorage resolves felt.json under the "UAppData" directory, which xpcshell
// does not provide by default. Point it at a directory inside the test profile
// so the module can load and persist without touching any real user data, and
// before any test statically imports FeltStorage.
(function setupFeltAppData() {
  const profileDir = do_get_profile();
  const appData = profileDir.clone();
  appData.append("felt-app-data");
  if (!appData.exists()) {
    appData.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  }
  const props = Services.dirsvc.QueryInterface(Ci.nsIProperties);
  if (!props.has("UAppData")) {
    props.set("UAppData", appData);
  }
})();
