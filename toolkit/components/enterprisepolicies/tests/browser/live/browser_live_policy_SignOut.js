/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PREF_SHUTDOWN = "enterprise.locking.shutdown";
const PREF_CRASH = "enterprise.locking.crash";

function checkPref(prefName, locked, value) {
  Assert.equal(
    Services.prefs.prefIsLocked(prefName),
    locked,
    `${prefName} is ${locked ? "locked" : "unlocked"}`
  );
  Assert.strictEqual(
    Services.prefs.getBoolPref(prefName, false),
    value,
    `${prefName} is ${value}`
  );
}

function checkState(locked, value) {
  checkPref(PREF_SHUTDOWN, locked, value);
  checkPref(PREF_CRASH, locked, value);
  Assert.strictEqual(
    EnterpriseHandler.willLockOnShutdown,
    value,
    `willLockOnShutdown reflects the pref (${value})`
  );
}

// Changing the SignOut actions through a live policy update must take effect
// on the next browser shutdown or crash-abort without a restart:
// willLockOnShutdown reads the pref freshly each time, and the crash pref is
// re-relayed to FELT on every change.
add_task(async function test_signout_live_update() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        SignOut: {
          Shutdown: { Action: "lock" },
          Crash: { Action: "lock" },
        },
      },
    },
    null
  );

  checkState(true, true);

  info("Live-updating SignOut to signout");
  await waitForLivePolicyUpdate({
    SignOut: {
      Shutdown: { Action: "signout" },
      Crash: { Action: "signout" },
    },
  });

  checkState(true, false);
});

// Removing SignOut through a live policy update must restore the pre-policy
// preference state without a restart.
add_task(async function test_signout_live_removal() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  // Capture the pre-policy values so the assertions hold regardless of the
  // build-time defaults.
  const baselineShutdown = Services.prefs.getBoolPref(PREF_SHUTDOWN, false);
  const baselineCrash = Services.prefs.getBoolPref(PREF_CRASH, false);

  info("Applying SignOut with signout actions");
  await waitForLivePolicyUpdate({
    SignOut: {
      Shutdown: { Action: "signout" },
      Crash: { Action: "signout" },
    },
  });

  checkState(true, false);

  info("Removing SignOut");
  await waitForLivePolicyUpdate({});

  // Removal restores the default values but always re-locks, matching the
  // locked defaults enterprise builds ship.
  checkPref(PREF_SHUTDOWN, true, baselineShutdown);
  checkPref(PREF_CRASH, true, baselineCrash);
});
