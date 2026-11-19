/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ConsoleClient, CONSOLE_ADDRESS_PREF, CONSOLE_ADDRESS_PLACEHOLDER } =
  ChromeUtils.importESModule(
    "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs"
  );
const {
  RELATIVE_CONSOLE_ENDPOINT_PREFS,
  BASE_CONSOLE_URI_PREFS,
  EnterpriseEndpoints,
} = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/enterprise/modules/EnterpriseEndpoints.sys.mjs"
);

const CONSOLE_URL_ENV = "MOZ_ENTERPRISE_CONSOLE_URL";

add_task(async function test_endpoints_derived_from_console_address() {
  const defaultBranch = Services.prefs.getDefaultBranch("");
  const savedPrefs = [
    ...RELATIVE_CONSOLE_ENDPOINT_PREFS.map(({ pref }) => pref),
    ...BASE_CONSOLE_URI_PREFS,
  ].map(pref => ({
    pref,
    value: defaultBranch.getStringPref(pref, null),
    locked: Services.prefs.prefIsLocked(pref),
  }));
  registerCleanupFunction(() => {
    for (const { pref, value, locked } of savedPrefs) {
      Services.prefs.unlockPref(pref);
      if (value !== null) {
        defaultBranch.setStringPref(pref, value);
      }
      if (locked) {
        Services.prefs.lockPref(pref);
      }
    }
  });

  // Generic builds get the console address at runtime.
  if (
    Services.prefs.getStringPref(CONSOLE_ADDRESS_PREF) ==
      CONSOLE_ADDRESS_PLACEHOLDER &&
    !Services.env.get(CONSOLE_URL_ENV)
  ) {
    Services.env.set(CONSOLE_URL_ENV, "https://console.example.com/");
    registerCleanupFunction(() => Services.env.set(CONSOLE_URL_ENV, ""));
  }

  await EnterpriseEndpoints.init();
  const consoleAddress = (await ConsoleClient.consoleBaseURI).href;

  for (const { pref, path } of RELATIVE_CONSOLE_ENDPOINT_PREFS) {
    Assert.equal(
      Services.prefs.getStringPref(pref),
      new URL(path, consoleAddress).href,
      `Expected ${pref} to be set and derived from console address`
    );
    Assert.ok(
      Services.prefs.prefIsLocked(pref),
      `Expected preferences ${pref} to be locked.`
    );
  }

  for (const pref of BASE_CONSOLE_URI_PREFS) {
    Assert.equal(
      Services.prefs.getStringPref(pref),
      consoleAddress,
      `Expected ${pref} to be set to the console address`
    );
    Assert.ok(
      Services.prefs.prefIsLocked(pref),
      `Expected preferences ${pref} to be locked.`
    );
  }
});
