// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
"use strict";

// A module named only in the profile's pkcs11.txt must not be auto-loaded when
// profile PKCS#11 modules are disabled (MOZ_DISABLE_PROFILE_PKCS11_MODULES, as
// on enterprise): that file is user-writable and NSS_Initialize would dlopen
// its entries before the policy engine runs. When they are enabled the module
// loads, which also confirms this fixture is genuinely loadable (the disabled
// result is the fix, not a broken fixture).

add_task(async function test_profile_pkcs11_module_autoload() {
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

  // Initialize NSS.
  Cc["@mozilla.org/psm;1"].getService(Ci.nsINSSComponent);

  let pkcs11ModuleDB = Cc["@mozilla.org/security/pkcs11moduledb;1"].getService(
    Ci.nsIPKCS11ModuleDB
  );
  let loaded = (await pkcs11ModuleDB.listModules())
    .map(module => module.name)
    .includes("ProfileInjectedModule");

  if (AppConstants.MOZ_DISABLE_PROFILE_PKCS11_MODULES) {
    ok(!loaded, "profile-injected module must not be loaded on enterprise");
  } else {
    ok(loaded, "profile-injected module is loaded on non-enterprise builds");
  }
});
