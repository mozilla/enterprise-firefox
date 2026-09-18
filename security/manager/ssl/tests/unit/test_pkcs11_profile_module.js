// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
"use strict";

// A module named only in the profile's pkcs11.txt must not be auto-loaded on
// enterprise builds: that file is user-writable and NSS_Initialize would
// dlopen its entries before the enterprise policy engine runs. Non-enterprise
// builds keep loading it, so this also confirms the module is genuinely
// loadable (i.e. the enterprise result is the fix, not a broken fixture).

add_task(async function test_profile_pkcs11_module_autoload() {
  let profile = do_get_profile(); // must run before NSS is initialized

  let libraryFile = Services.dirsvc.get("CurWorkD", Ci.nsIFile);
  libraryFile.append("pkcs11testmodule");
  libraryFile.append(ctypes.libraryName("pkcs11testmodule"));
  ok(libraryFile.exists(), "The pkcs11testmodule file should exist");

  // Seed pkcs11.txt as a user with profile write access could. The internal
  // module record mirrors what NSS writes for itself; NSS uses the directory
  // passed to NSS_Initialize (the profile) for the actual databases. library=
  // values are unquoted and read literally, so the path is written as-is.
  let pkcs11txt =
    "library=\n" +
    "name=NSS Internal PKCS #11 Module\n" +
    "parameters=configdir='.' certPrefix='' keyPrefix='' secmod='secmod.db' " +
    "flags=optimizeSpace\n" +
    "NSS=Flags=internal,critical trustOrder=75 cipherOrder=100 " +
    "slotParams=(1={slotFlags=[RSA,DSA,DH,RC2,RC4,DES,RANDOM,SHA1,MD5,MD2,SSL," +
    "TLS,AES,Camellia,SEED,SHA256,SHA512] askpw=any timeout=30})\n" +
    "\n" +
    `library=${libraryFile.path}\n` +
    "name=ProfileInjectedModule\n";
  let pkcs11File = profile.clone();
  pkcs11File.append("pkcs11.txt");
  await IOUtils.writeUTF8(pkcs11File.path, pkcs11txt);

  // Initialize NSS.
  Cc["@mozilla.org/psm;1"].getService(Ci.nsINSSComponent);

  let pkcs11ModuleDB = Cc["@mozilla.org/security/pkcs11moduledb;1"].getService(
    Ci.nsIPKCS11ModuleDB
  );
  let loaded = (await pkcs11ModuleDB.listModules())
    .map(module => module.name)
    .includes("ProfileInjectedModule");

  if (AppConstants.MOZ_ENTERPRISE) {
    ok(!loaded, "profile-injected module must not be loaded on enterprise");
  } else {
    ok(loaded, "profile-injected module is loaded on non-enterprise builds");
  }
});
