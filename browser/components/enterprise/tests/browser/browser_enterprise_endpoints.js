/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ConsoleClient, CONSOLE_ADDRESS_PREF } = ChromeUtils.importESModule(
  "resource:///modules/enterprise/ConsoleClient.sys.mjs"
);
const {
  RELATIVE_CONSOLE_ENDPOINT_PREFS,
  BASE_CONSOLE_URI_PREFS,
  EnterpriseEndpoints,
} = ChromeUtils.importESModule(
  "resource:///modules/enterprise/EnterpriseEndpoints.sys.mjs"
);

const CONSOLE_ADDRESS_PREF_VALUE =
  Services.prefs.getStringPref(CONSOLE_ADDRESS_PREF);

add_task(async function test_endpoints_derived_from_console_address() {
  EnterpriseEndpoints.init();

  for (const { pref, path } of RELATIVE_CONSOLE_ENDPOINT_PREFS) {
    const url = new URL(path, CONSOLE_ADDRESS_PREF_VALUE).href;
    Assert.equal(
      Services.prefs.getStringPref(pref),
      url,
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
      CONSOLE_ADDRESS_PREF_VALUE,
      `Expected ${pref} to be set to the console address`
    );
    Assert.ok(
      Services.prefs.prefIsLocked(pref),
      `Expected preferences ${pref} to be locked.`
    );
  }
});
