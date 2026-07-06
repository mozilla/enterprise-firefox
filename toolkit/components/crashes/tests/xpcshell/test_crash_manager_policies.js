/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TelemetryArchiveTesting } = ChromeUtils.importESModule(
  "resource://testing-common/TelemetryArchiveTesting.sys.mjs"
);
const { configureLogging, getManager } = ChromeUtils.importESModule(
  "resource://testing-common/CrashManagerTest.sys.mjs"
);
const { makeFakeAppDir } = ChromeUtils.importESModule(
  "resource://testing-common/AppData.sys.mjs"
);
const { EnterprisePolicyTesting } = ChromeUtils.importESModule(
  "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
);

// Initialize the policy engine for xpcshell
let policies = Cc["@mozilla.org/enterprisepolicies;1"].getService(
  Ci.nsIObserver
);
policies.observe(null, "policies-startup", null);

const DUMMY_DATE = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
DUMMY_DATE.setMilliseconds(0);

function run_test() {
  do_get_profile();
  configureLogging();
  TelemetryArchiveTesting.setup();
  // Initialize FOG for glean tests
  Services.fog.initializeFOG();

  // We need a UAppData directory for the glean store.
  //
  // We use `do_test_pending()`/`do_test_finished()` because `run_test()` must
  // not return until all tests are complete.
  do_test_pending();
  makeFakeAppDir().then(() => {
    run_next_test();
    do_test_finished();
  });
}

add_task(async function test_schedule_maintenance_policyDisabled() {
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({
    policies: {
      CrashReportsSubmit: {
        Enabled: false,
      },
    },
  });

  try {
    let m = await getManager();
    m._disableGleanPing = false;
    await m.createEventsFile("1", "crash.main.3", DUMMY_DATE, "id1", "{}");

    let oldDate = new Date(
      Date.now() - m.PURGE_OLDER_THAN_DAYS * 2 * 24 * 60 * 60 * 1000
    );
    await m.createEventsFile("2", "crash.main.3", oldDate, "id2", "{}");

    await m.scheduleMaintenance(25);

    // The aggregate / prune phases of maintenance must still run.
    let crashes = await m.getCrashes();
    Assert.equal(crashes.length, 1);
    Assert.equal(crashes[0].id, "id1");

    // But cleanupPings must be skipped: the helper is never invoked, so the
    // result property stays undefined.
    Assert.strictEqual(
      m._cleanupPingsResult,
      undefined,
      "cleanupPings must not run while CrashReportsSubmit.Enabled is set to false"
    );
  } finally {
    await EnterprisePolicyTesting.setupPolicyEngineWithJson("");
  }
});

add_task(async function test_sendUnsubmittedPings_policyDisabled() {
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({
    policies: {
      CrashReportsSubmit: {
        Enabled: false,
      },
    },
  });

  try {
    let m = await getManager();
    let store = await m._getStore();
    store.addCrash(
      m.processTypes[Ci.nsIXULRuntime.PROCESS_TYPE_DEFAULT],
      m.CRASH_TYPE_CRASH,
      "policy-disabled-crash",
      DUMMY_DATE,
      {}
    );

    {
      const crashes = store.crashesWithoutPingSubmissions();
      Assert.equal(crashes.length, 1);
      Assert.equal(crashes[0].id, "policy-disabled-crash");
    }

    m._disableGleanPing = false;

    await m.sendUnsubmittedPings();
    Assert.equal(
      m._gleanPingPromise,
      null,
      "Should not enqueue a Glean ping while CrashReportsSubmit.Enabled is set to false"
    );
    Assert.equal(
      store.crashesWithoutPingSubmissions().length,
      0,
      "Pings under the Disabled policy must still be marked submitted to avoid endless retries"
    );
  } finally {
    await EnterprisePolicyTesting.setupPolicyEngineWithJson("");
  }
});
