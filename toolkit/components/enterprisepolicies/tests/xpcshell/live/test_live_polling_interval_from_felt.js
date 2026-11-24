/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const ConsoleAPIStorage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(
  Ci.nsIConsoleAPIStorage
);

add_setup(function () {
  Services.prefs.setStringPref("browser.policies.loglevel", "debug");
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("browser.policies.loglevel");
  });
});

add_task(async function test_interval_from_felt_config() {
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

  EnterprisePolicyTesting.stubFirefoxConfig({ pollingFrequency: 750 });
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
    EnterprisePolicyTesting.stubFirefoxConfig({ pollingFrequency: 500 });
    ConsoleAPIStorage.removeLogEventListener(listener);
  }

  Assert.equal(intervals[0], 750, "The console's interval is used");
});
