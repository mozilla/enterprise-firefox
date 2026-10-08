/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PREF_SHUTDOWN = "enterprise.locking.shutdown";
const PREF_RESTART = "enterprise.locking.restart";

function checkState(prefName, locked, value) {
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

function checkShutdownState(locked, value) {
  checkState(PREF_SHUTDOWN, locked, value);
  Assert.strictEqual(
    EnterpriseHandler.willLockOnShutdown,
    value,
    `willLockOnShutdown reflects the pref (${value})`
  );
}

function checkRestartState(locked, value) {
  checkState(PREF_RESTART, locked, value);
  Assert.strictEqual(
    EnterpriseHandler.willLockOnRestart,
    value,
    `willLockOnRestart reflects the pref (${value})`
  );
}

// Changing the SignOut actions through a live policy update must take effect on
// the next shutdown or update-driven restart without relaunching the browser,
// since both intents read their pref freshly each time. The two sub-policies
// are driven to opposite actions so a crossed wire between them fails here.
add_task(async function test_signout_live_update() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        SignOut: {
          Shutdown: { Action: "lock" },
          Restart: { Action: "signout" },
        },
      },
    },
    null
  );

  checkShutdownState(true, true);
  checkRestartState(true, false);

  info("Live-updating SignOut to swap both actions");
  await waitForLivePolicyUpdate({
    SignOut: {
      Shutdown: { Action: "signout" },
      Restart: { Action: "lock" },
    },
  });

  checkShutdownState(true, false);
  checkRestartState(true, true);
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
  const shutdownBaseline = Services.prefs.getBoolPref(PREF_SHUTDOWN, false);
  const restartBaseline = Services.prefs.getBoolPref(PREF_RESTART, false);

  info("Applying SignOut with signout actions");
  await waitForLivePolicyUpdate({
    SignOut: {
      Shutdown: { Action: "signout" },
      Restart: { Action: "signout" },
    },
  });

  checkShutdownState(true, false);
  checkRestartState(true, false);

  info("Removing SignOut");
  await waitForLivePolicyUpdate({});

  // Removal restores the default value but always re-locks, matching the
  // locked default enterprise builds ship.
  checkShutdownState(true, shutdownBaseline);
  checkRestartState(true, restartBaseline);
});

// Each sub-policy is independently optional, so setting one must leave the
// other's preference at its pre-policy state.
add_task(async function test_signout_partial_policy() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const restartLocked = Services.prefs.prefIsLocked(PREF_RESTART);
  const restartBaseline = Services.prefs.getBoolPref(PREF_RESTART, false);

  info("Applying SignOut with only a Shutdown action");
  await waitForLivePolicyUpdate({
    SignOut: { Shutdown: { Action: "lock" } },
  });

  checkShutdownState(true, true);
  checkRestartState(restartLocked, restartBaseline);
});
