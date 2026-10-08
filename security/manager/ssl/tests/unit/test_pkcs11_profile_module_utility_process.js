// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
"use strict";

// Like test_pkcs11_profile_module.js, but with the PKCS#11 utility process
// enabled: it initializes NSS on the same profile and must not auto-load the
// profile's modules either.

add_task(async function test_profile_pkcs11_module_autoload_utility_process() {
  let profile = do_get_profile(); // must run before NSS is initialized

  let libraryFile = Services.dirsvc.get("CurWorkD", Ci.nsIFile);
  libraryFile.append("pkcs11testmodule");
  libraryFile.append(ctypes.libraryName("pkcs11testmodule"));
  ok(libraryFile.exists(), "The pkcs11testmodule file should exist");

  await writeProfilePKCS11ModuleDB(
    profile,
    "ProfileInjectedModule",
    libraryFile.path
  );

  Cc["@mozilla.org/psm;1"].getService(Ci.nsINSSComponent);

  let pkcs11ModuleDB = Cc["@mozilla.org/security/pkcs11moduledb;1"].getService(
    Ci.nsIPKCS11ModuleDB
  );
  let timesLoaded = (await pkcs11ModuleDB.listModules()).filter(
    module => module.name == "ProfileInjectedModule"
  ).length;

  if (AppConstants.MOZ_DISABLE_PROFILE_PKCS11_MODULES) {
    equal(
      timesLoaded,
      0,
      "profile-injected module must not be loaded in either process"
    );
  } else {
    Assert.greaterOrEqual(
      timesLoaded,
      1,
      "profile-injected module is loaded when profile modules are enabled"
    );
  }
});
