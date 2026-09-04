/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// FeltStorage computes FELT_FILE_PATH from UAppData at import time, so the
// key must point inside the test profile before the module is imported.
const gDataHome = do_get_profile().clone();
gDataHome.append("appdata");
gDataHome.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
Services.dirsvc.set("UAppData", gDataHome);

const { ConsoleClient, CONSOLE_ADDRESS_PREF, CONSOLE_ADDRESS_PLACEHOLDER } =
  ChromeUtils.importESModule(
    "resource://gre/modules/enterprise/ConsoleClient.sys.mjs"
  );
const { FeltStorage } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/FeltStorage.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const ENV_VAR = "MOZ_ENTERPRISE_CONSOLE_URL";

// Test harnesses set MOZ_ENTERPRISE_CONSOLE_URL globally, so every scenario
// must set it explicitly rather than rely on it being absent.
const gOriginalEnv = Services.env.get(ENV_VAR);

registerCleanupFunction(async () => {
  Services.env.set(ENV_VAR, gOriginalEnv);
  Services.prefs.clearUserPref(CONSOLE_ADDRESS_PREF);
  await FeltStorage.uninit();
  await IOUtils.remove(FeltStorage.FELT_FILE_PATH, { ignoreAbsent: true });
});

// Puts the pref, the environment variable and felt.json in the given state,
// then returns the resolved console base URI promise.
async function resolveWith({ pref, env = "", stored = null }) {
  ConsoleClient._consoleUriReadyPromise = null;
  Services.env.set(ENV_VAR, env);

  await FeltStorage.uninit();
  await IOUtils.remove(FeltStorage.FELT_FILE_PATH, { ignoreAbsent: true });
  if (stored) {
    await FeltStorage.init();
    await FeltStorage.persistConsoleAddress(stored);
    // Leave the storage uninitialized so the resolution reads it back from
    // disk, like the post-dialog relaunch does.
    await FeltStorage.uninit();
  }

  Services.prefs.setStringPref(CONSOLE_ADDRESS_PREF, pref);
  return ConsoleClient.consoleBaseURI;
}

add_task(async function test_real_address_passes_through() {
  const url = await resolveWith({
    pref: "https://real.example.com/",
    env: "https://env.example.com/",
    stored: "https://stored.example.com/",
  });
  Assert.equal(
    url.href,
    "https://real.example.com/",
    "A repacked build's baked-in address wins over environment and storage"
  );
});

add_task(async function test_placeholder_resolves_from_environment() {
  const url = await resolveWith({
    pref: CONSOLE_ADDRESS_PLACEHOLDER,
    env: "https://env.example.com/",
    stored: "https://stored.example.com/",
  });
  Assert.equal(
    url.href,
    "https://env.example.com/",
    "The placeholder resolves from the environment before storage"
  );
});

add_task(async function test_placeholder_resolves_from_storage() {
  const url = await resolveWith({
    pref: CONSOLE_ADDRESS_PLACEHOLDER,
    stored: "https://stored.example.com/",
  });
  Assert.equal(
    url.href,
    "https://stored.example.com/",
    "The placeholder resolves from the address the setup dialog persisted"
  );
});

add_task(async function test_placeholder_unresolvable_rejects_uncached() {
  await Assert.rejects(
    resolveWith({ pref: CONSOLE_ADDRESS_PLACEHOLDER }),
    /no stored address/,
    "The placeholder with no environment or stored address rejects"
  );

  await TestUtils.waitForCondition(
    () => ConsoleClient._consoleUriReadyPromise === null,
    "A failed resolution must not stay cached for the session"
  );

  // Once an address exists (the setup dialog saved one), the next access
  // succeeds without a restart.
  await FeltStorage.init();
  await FeltStorage.persistConsoleAddress("https://recovered.example.com/");
  const url = await ConsoleClient.consoleBaseURI;
  Assert.equal(
    url.href,
    "https://recovered.example.com/",
    "Resolution recovers once an address is stored"
  );
});

add_task(async function test_waits_for_pref_to_appear() {
  // AutoConfig sets the pref only once the pref service evaluates the file,
  // so the client observes the pref when it is not there yet.
  ConsoleClient._consoleUriReadyPromise = null;
  Services.env.set(ENV_VAR, "");
  Services.prefs.clearUserPref(CONSOLE_ADDRESS_PREF);

  const promise = ConsoleClient.consoleBaseURI.then(url =>
    Assert.equal(
      url.href,
      "https://late.example.com/",
      "The address resolves once the pref appears"
    )
  );

  Services.prefs.setStringPref(
    CONSOLE_ADDRESS_PREF,
    "https://late.example.com/"
  );

  await promise;
});
