// Any copyright is dedicated to the Public Domain.
// http://creativecommons.org/publicdomain/zero/1.0/
"use strict";

// Tests that adding modules with invalid names are prevented.

// Ensure that the appropriate initialization has happened.
do_get_profile();

add_task(async function run_test() {
  let libraryFile = Services.dirsvc.get("CurWorkD", Ci.nsIFile);
  libraryFile.append("pkcs11testmodule");
  libraryFile.append(ctypes.libraryName("pkcs11testmodule"));
  ok(libraryFile.exists(), "The pkcs11testmodule file should exist");

  let moduleDB = Cc["@mozilla.org/security/pkcs11moduledb;1"].getService(
    Ci.nsIPKCS11ModuleDB
  );
  // NB: These throw before the promise is created.
  throws(
    () => moduleDB.addModule("Root Certs", libraryFile.path, 0, 0),
    /NS_ERROR_ILLEGAL_VALUE/,
    "Adding a module named 'Root Certs' should fail."
  );
  throws(
    () => moduleDB.addModule("", libraryFile.path, 0, 0),
    /NS_ERROR_ILLEGAL_VALUE/,
    "Adding a module with an empty name should fail."
  );

  let bundle = Services.strings.createBundle(
    "chrome://pipnss/locale/pipnss.properties"
  );
  let rootsModuleName = bundle.GetStringFromName("RootCertModuleName");
  let foundRootsModule = false;
  for (let module of await moduleDB.listModules()) {
    if (module.name == rootsModuleName) {
      foundRootsModule = true;
      break;
    }
  }
  ok(
    foundRootsModule,
    "Should be able to find builtin roots module by localized name."
  );
});

// A module name containing characters that are significant inside an NSS
// module spec (a double-quote and a backslash) must round-trip: the path that
// loads modules without a profile module DB builds a spec string for
// SECMOD_LoadUserModule, so it has to quote the name correctly. This is a
// correctness/regression guard for that quoting, not a security boundary --
// addModule's callers (the SecurityDevices policy, Device Manager) are trusted.
// See bug 2068739.
add_task(async function test_module_name_with_spec_metacharacters() {
  let libraryFile = Services.dirsvc.get("CurWorkD", Ci.nsIFile);
  libraryFile.append("pkcs11testmodule");
  libraryFile.append(ctypes.libraryName("pkcs11testmodule"));

  let moduleDB = Cc["@mozilla.org/security/pkcs11moduledb;1"].getService(
    Ci.nsIPKCS11ModuleDB
  );

  // A name whose characters would be significant in an unquoted spec string.
  let trickyName = 'tricky" library="/other\\path';
  await moduleDB.addModule(trickyName, libraryFile.path, 0, 0);

  let names = (await moduleDB.listModules()).map(module => module.name);
  ok(
    names.includes(trickyName),
    `module should load under its exact name (got ${JSON.stringify(names)})`
  );

  await moduleDB.deleteModule(trickyName);
  names = (await moduleDB.listModules()).map(module => module.name);
  ok(!names.includes(trickyName), "module should be gone after delete");
});
