/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PREF_SHUTDOWN = "enterprise.locking.shutdown";
const PREF_RESTART = "enterprise.locking.restart";
const PREF_CRASH = "enterprise.locking.crash";
const PREF_NETWORK_LOSS = "enterprise.locking.network_loss";
const PREF_GRACE_PERIOD = "enterprise.network_loss.grace_period_minutes";

const { ConsoleConnectionGuard } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/ConsoleConnectionGuard.sys.mjs"
);

// Enabling a NetworkLoss action lets the guard arm off the failing console
// polls this environment produces, which would end the session once the grace
// period elapsed. Disarm it so it cannot fire after the tests finish.
registerCleanupFunction(() => {
  ConsoleConnectionGuard.reset();
});

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

function checkCrashState(locked, value) {
  checkState(PREF_CRASH, locked, value);
  Assert.strictEqual(
    EnterpriseHandler.willLockOnCrash,
    value,
    `willLockOnCrash reflects the pref (${value})`
  );
}

function checkNetworkLossState(locked, value) {
  checkState(PREF_NETWORK_LOSS, locked, value);
  Assert.strictEqual(
    EnterpriseHandler.willLockOnNetworkLoss,
    value,
    `willLockOnNetworkLoss reflects the pref (${value})`
  );
}

// A live SignOut update changes the locking prefs and their getters without
// relaunching the browser.
add_task(async function test_signout_live_update() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        SignOut: {
          Shutdown: { Action: "lock" },
          Restart: { Action: "signout" },
          Crash: { Action: "lock" },
        },
      },
    },
    null
  );

  checkShutdownState(true, true);
  checkRestartState(true, false);
  checkCrashState(true, true);

  info("Live-updating SignOut to swap all actions");
  await waitForLivePolicyUpdate({
    SignOut: {
      Shutdown: { Action: "signout" },
      Restart: { Action: "lock" },
      Crash: { Action: "signout" },
    },
  });

  checkShutdownState(true, false);
  checkRestartState(true, true);
  checkCrashState(true, false);
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
  const crashBaseline = Services.prefs.getBoolPref(PREF_CRASH, false);

  info("Applying SignOut with signout actions");
  await waitForLivePolicyUpdate({
    SignOut: {
      Shutdown: { Action: "signout" },
      Restart: { Action: "signout" },
      Crash: { Action: "signout" },
    },
  });

  checkShutdownState(true, false);
  checkRestartState(true, false);
  checkCrashState(true, false);

  info("Removing SignOut");
  await waitForLivePolicyUpdate({});

  // Removal restores the default value but always re-locks, matching the
  // locked default enterprise builds ship.
  checkShutdownState(true, shutdownBaseline);
  checkRestartState(true, restartBaseline);
  checkCrashState(true, crashBaseline);
});

// Each sub-policy is independently optional, so setting one must leave the
// others' preferences at their pre-policy state.
add_task(async function test_signout_partial_policy() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const restartLocked = Services.prefs.prefIsLocked(PREF_RESTART);
  const restartBaseline = Services.prefs.getBoolPref(PREF_RESTART, false);
  const crashLocked = Services.prefs.prefIsLocked(PREF_CRASH);
  const crashBaseline = Services.prefs.getBoolPref(PREF_CRASH, false);
  const networkLossLocked = Services.prefs.prefIsLocked(PREF_NETWORK_LOSS);
  const networkLossBaseline = Services.prefs.getBoolPref(
    PREF_NETWORK_LOSS,
    false
  );

  info("Applying SignOut with only a Shutdown action");
  await waitForLivePolicyUpdate({
    SignOut: { Shutdown: { Action: "lock" } },
  });

  checkShutdownState(true, true);
  checkRestartState(restartLocked, restartBaseline);
  checkCrashState(crashLocked, crashBaseline);
  checkNetworkLossState(networkLossLocked, networkLossBaseline);
});

// Like Shutdown and Restart, the NetworkLoss action maps to a boolean locking
// pref; unlike them it also carries a grace period.
add_task(async function test_network_loss_actions() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const lockBaseline = Services.prefs.getBoolPref(PREF_NETWORK_LOSS, false);
  const graceBaseline = Services.prefs.getIntPref(PREF_GRACE_PERIOD, 0);
  Assert.strictEqual(
    Services.prefs.getDefaultBranch("").getIntPref(PREF_GRACE_PERIOD),
    15,
    "The shipped network-loss grace period is 15 minutes."
  );

  for (const action of ["lock", "signout"]) {
    info(`Applying NetworkLoss with a ${action} action`);
    await waitForLivePolicyUpdate({
      SignOut: { NetworkLoss: { Action: action, GracePeriodMinutes: 42 } },
    });

    checkNetworkLossState(true, action === "lock");
    Assert.ok(
      Services.prefs.prefIsLocked(PREF_GRACE_PERIOD),
      `${PREF_GRACE_PERIOD} is locked`
    );
    Assert.strictEqual(
      Services.prefs.getIntPref(PREF_GRACE_PERIOD, 0),
      42,
      `${PREF_GRACE_PERIOD} is 42`
    );
  }

  info("Removing SignOut");
  await waitForLivePolicyUpdate({});

  checkNetworkLossState(true, lockBaseline);
  Assert.strictEqual(
    Services.prefs.getIntPref(PREF_GRACE_PERIOD, 0),
    graceBaseline,
    `${PREF_GRACE_PERIOD} is restored to its pre-policy value`
  );
  Assert.ok(
    Services.prefs.prefIsLocked(PREF_GRACE_PERIOD),
    `${PREF_GRACE_PERIOD} is re-locked after removal`
  );
});

// GracePeriodMinutes is optional, including after a live policy update.
add_task(async function test_network_loss_grace_period_optional() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const graceBaseline = Services.prefs.getIntPref(PREF_GRACE_PERIOD, 0);

  await waitForLivePolicyUpdate({
    SignOut: { NetworkLoss: { Action: "lock", GracePeriodMinutes: 42 } },
  });
  Assert.strictEqual(Services.prefs.getIntPref(PREF_GRACE_PERIOD, 0), 42);

  await waitForLivePolicyUpdate({
    SignOut: { NetworkLoss: { Action: "signout" } },
  });

  checkNetworkLossState(true, false);
  Assert.strictEqual(
    Services.prefs.getIntPref(PREF_GRACE_PERIOD, 0),
    graceBaseline,
    `${PREF_GRACE_PERIOD} keeps its default`
  );

  await waitForLivePolicyUpdate({
    SignOut: { NetworkLoss: { Action: "lock", GracePeriodMinutes: 42 } },
  });
  await waitForLivePolicyUpdate({
    SignOut: { Shutdown: { Action: "signout" } },
  });
  checkNetworkLossState(true, false);
  Assert.strictEqual(
    Services.prefs.getIntPref(PREF_GRACE_PERIOD, 0),
    graceBaseline,
    `${PREF_GRACE_PERIOD} restores its default when NetworkLoss is removed`
  );

  info("Removing SignOut");
  await waitForLivePolicyUpdate({});
});
