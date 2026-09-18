/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PREF_NAME = "enterprise.locking.shutdown";

const { ConsoleConnectionGuard } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/ConsoleConnectionGuard.sys.mjs"
);

// Enabling a NetworkLoss action lets the guard arm off the failing console
// polls this environment produces, which would end the session once the grace
// period elapsed. Disarm it so it cannot fire after the tests finish.
registerCleanupFunction(() => {
  ConsoleConnectionGuard.reset();
});

function checkState(locked, value) {
  Assert.equal(
    Services.prefs.prefIsLocked(PREF_NAME),
    locked,
    `${PREF_NAME} is ${locked ? "locked" : "unlocked"}`
  );
  Assert.strictEqual(
    Services.prefs.getBoolPref(PREF_NAME, false),
    value,
    `${PREF_NAME} is ${value}`
  );
  Assert.strictEqual(
    EnterpriseHandler.willLockOnShutdown,
    value,
    `willLockOnShutdown reflects the pref (${value})`
  );
}

// Changing the SignOut action through a live policy update must take effect on
// the next browser shutdown without a restart, since willLockOnShutdown reads
// the pref freshly each time.
add_task(async function test_signout_live_update() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        SignOut: { Shutdown: { Action: "lock" } },
      },
    },
    null
  );

  checkState(true, true);

  info("Live-updating SignOut to signout");
  await waitForLivePolicyUpdate({
    SignOut: { Shutdown: { Action: "signout" } },
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

  // Capture the pre-policy value so the assertion holds regardless of the
  // build-time default.
  const baselineValue = Services.prefs.getBoolPref(PREF_NAME, false);

  info("Applying SignOut with a signout action");
  await waitForLivePolicyUpdate({
    SignOut: { Shutdown: { Action: "signout" } },
  });

  checkState(true, false);

  info("Removing SignOut");
  await waitForLivePolicyUpdate({});

  // Removal restores the default value but always re-locks, matching the
  // locked default enterprise builds ship.
  checkState(true, baselineValue);
});

const LOCK_ON_NETWORK_LOSS_PREF = "enterprise.locking.network_loss";
const GRACE_PERIOD_PREF = "enterprise.network_loss.grace_period_minutes";

// Like Shutdown, the NetworkLoss action maps to a boolean locking pref; unlike
// Shutdown it comes with a grace period.
add_task(async function test_network_loss_actions() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const baselineLock = Services.prefs.getBoolPref(
    LOCK_ON_NETWORK_LOSS_PREF,
    false
  );
  const baselineGrace = Services.prefs.getIntPref(GRACE_PERIOD_PREF, 0);

  for (const action of ["lock", "signout"]) {
    info(`Applying NetworkLoss with a ${action} action`);
    await waitForLivePolicyUpdate({
      SignOut: { NetworkLoss: { Action: action, GracePeriodMinutes: 42 } },
    });

    const expectedLock = action === "lock";
    Assert.ok(
      Services.prefs.prefIsLocked(LOCK_ON_NETWORK_LOSS_PREF),
      `${LOCK_ON_NETWORK_LOSS_PREF} is locked`
    );
    Assert.strictEqual(
      Services.prefs.getBoolPref(LOCK_ON_NETWORK_LOSS_PREF, false),
      expectedLock,
      `${LOCK_ON_NETWORK_LOSS_PREF} is ${expectedLock}`
    );
    Assert.strictEqual(
      EnterpriseHandler.willLockOnNetworkLoss,
      expectedLock,
      `willLockOnNetworkLoss reflects the pref (${expectedLock})`
    );
    Assert.strictEqual(
      Services.prefs.getIntPref(GRACE_PERIOD_PREF, 0),
      42,
      `${GRACE_PERIOD_PREF} is 42`
    );
  }

  info("Removing SignOut");
  await waitForLivePolicyUpdate({});

  Assert.strictEqual(
    Services.prefs.getBoolPref(LOCK_ON_NETWORK_LOSS_PREF, false),
    baselineLock,
    `${LOCK_ON_NETWORK_LOSS_PREF} is restored to its pre-policy value`
  );
  Assert.strictEqual(
    Services.prefs.getIntPref(GRACE_PERIOD_PREF, 0),
    baselineGrace,
    `${GRACE_PERIOD_PREF} is restored to its pre-policy value`
  );
  Assert.ok(
    Services.prefs.prefIsLocked(LOCK_ON_NETWORK_LOSS_PREF),
    `${LOCK_ON_NETWORK_LOSS_PREF} is re-locked after removal`
  );
});

// GracePeriodMinutes is optional; omitting it must leave the shipped default in
// place.
add_task(async function test_network_loss_grace_period_optional() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const baselineGrace = Services.prefs.getIntPref(GRACE_PERIOD_PREF, 0);

  await waitForLivePolicyUpdate({
    SignOut: { NetworkLoss: { Action: "signout" } },
  });

  Assert.strictEqual(
    Services.prefs.getBoolPref(LOCK_ON_NETWORK_LOSS_PREF, true),
    false,
    `${LOCK_ON_NETWORK_LOSS_PREF} is false`
  );
  Assert.strictEqual(
    Services.prefs.getIntPref(GRACE_PERIOD_PREF, 0),
    baselineGrace,
    `${GRACE_PERIOD_PREF} keeps its default`
  );

  info("Removing SignOut");
  await waitForLivePolicyUpdate({});
});
