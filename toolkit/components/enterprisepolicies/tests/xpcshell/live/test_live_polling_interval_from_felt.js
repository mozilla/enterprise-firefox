/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Regression test for Bug 2073053. A Felt browser takes the remote policy
// polling interval from the configuration Felt sends, and ignores the
// user-settable enterprise.policies.live.polling_interval pref, even when the
// console configuration has no interval.

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const ConsoleAPIStorage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(
  Ci.nsIConsoleAPIStorage
);

const POLLING_INTERVAL_PREF = "enterprise.policies.live.polling_interval";
const POLLING_INTERVAL_FALLBACK = 60_000;

// Restarts the engine as a Felt browser that received config (null for none),
// and returns the interval the remote provider started polling with.
async function startPollingAsFeltBrowser(config) {
  const intervals = [];
  const listener = event => {
    const match = /^Starting live policy polling every (\d+)ms\.$/.exec(
      String(event.arguments[0])
    );
    if (event.prefix == "Enterprise Policies" && match) {
      intervals.push(Number(match[1]));
    }
  };
  ConsoleAPIStorage.addLogEventListener(
    listener,
    Services.scriptSecurityManager.getSystemPrincipal()
  );

  const realFelt = Services.felt;
  Object.defineProperty(Services, "felt", {
    configurable: true,
    value: {
      isFeltBrowser: () => true,
      getFirefoxConfig() {
        if (config === null) {
          throw Components.Exception("", Cr.NS_ERROR_NOT_AVAILABLE);
        }
        return JSON.stringify(config);
      },
      performSignout() {},
    },
  });
  try {
    await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
      { policies: {} },
      null
    );
    await TestUtils.waitForCondition(
      () => intervals.length,
      "Waiting for remote policy polling to start"
    );
  } finally {
    Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
    Object.defineProperty(Services, "felt", {
      configurable: true,
      value: realFelt,
    });
    ConsoleAPIStorage.removeLogEventListener(listener);
  }
  return intervals[0];
}

add_setup(function () {
  Services.prefs.setStringPref("browser.policies.loglevel", "debug");
  Services.prefs.setIntPref(POLLING_INTERVAL_PREF, 2147483647);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("browser.policies.loglevel");
    Services.prefs.setIntPref(POLLING_INTERVAL_PREF, 500);
  });
});

add_task(async function test_interval_from_felt_config() {
  Assert.equal(
    await startPollingAsFeltBrowser({ polling_frequency: 750 }),
    750,
    "The console's interval is used, not the pref"
  );
});

add_task(async function test_fallback_without_interval_in_felt_config() {
  Assert.equal(
    await startPollingAsFeltBrowser({}),
    POLLING_INTERVAL_FALLBACK,
    "The fallback interval is used, not the pref"
  );
});

add_task(async function test_fallback_without_felt_config() {
  Assert.equal(
    await startPollingAsFeltBrowser(null),
    POLLING_INTERVAL_FALLBACK,
    "The fallback interval is used when Felt sent no configuration"
  );
});
