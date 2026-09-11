/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PREF_NAME = "enterprise.locking.browser_close";

const { ConsoleConnectionGuard } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/ConsoleConnectionGuard.sys.mjs"
);

// Enabling a ConnectionLoss action lets the guard arm off the failing console
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
    EnterpriseHandler.willLockOnClose,
    value,
    `willLockOnClose reflects the pref (${value})`
  );
}

// Changing the SignOut action through a live policy update must take effect on
// the next browser close without a restart, since willLockOnClose reads the
// pref freshly each time.
add_task(async function test_signout_live_update() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        SignOut: { BrowserClose: { Action: "lock" } },
      },
    },
    null
  );

  checkState(true, true);

  info("Live-updating SignOut to signout");
  await waitForLivePolicyUpdate({
    SignOut: { BrowserClose: { Action: "signout" } },
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
    SignOut: { BrowserClose: { Action: "signout" } },
  });

  checkState(true, false);

  info("Removing SignOut");
  await waitForLivePolicyUpdate({});

  // Removal restores the default value but always re-locks, matching the
  // locked default enterprise builds ship.
  checkState(true, baselineValue);
});

const ACTION_PREF = "enterprise.connection_loss.action";
const GRACE_PERIOD_PREF = "enterprise.connection_loss.grace_period";

// The ConnectionLoss action is a three-way choice, so unlike BrowserClose it
// maps to a string pref rather than a boolean.
add_task(async function test_connection_loss_actions() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const baselineAction = Services.prefs.getStringPref(ACTION_PREF, "none");
  const baselineGrace = Services.prefs.getIntPref(GRACE_PERIOD_PREF, 0);

  for (const action of ["signout", "lock", "none"]) {
    info(`Applying ConnectionLoss with a ${action} action`);
    await waitForLivePolicyUpdate({
      SignOut: { ConnectionLoss: { Action: action, GracePeriod: 42 } },
    });

    Assert.ok(
      Services.prefs.prefIsLocked(ACTION_PREF),
      `${ACTION_PREF} is locked`
    );
    Assert.strictEqual(
      Services.prefs.getStringPref(ACTION_PREF, "none"),
      action,
      `${ACTION_PREF} is ${action}`
    );
    Assert.strictEqual(
      EnterpriseHandler.connectionLossAction,
      action,
      `connectionLossAction reflects the pref (${action})`
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
    Services.prefs.getStringPref(ACTION_PREF, "none"),
    baselineAction,
    `${ACTION_PREF} is restored to its pre-policy value`
  );
  Assert.strictEqual(
    Services.prefs.getIntPref(GRACE_PERIOD_PREF, 0),
    baselineGrace,
    `${GRACE_PERIOD_PREF} is restored to its pre-policy value`
  );
});

// GracePeriod is optional; omitting it must leave the shipped default in place.
add_task(async function test_connection_loss_grace_period_optional() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const baselineGrace = Services.prefs.getIntPref(GRACE_PERIOD_PREF, 0);

  await waitForLivePolicyUpdate({
    SignOut: { ConnectionLoss: { Action: "signout" } },
  });

  Assert.strictEqual(
    Services.prefs.getStringPref(ACTION_PREF, "none"),
    "signout",
    `${ACTION_PREF} is signout`
  );
  Assert.strictEqual(
    Services.prefs.getIntPref(GRACE_PERIOD_PREF, 0),
    baselineGrace,
    `${GRACE_PERIOD_PREF} keeps its default`
  );

  info("Removing SignOut");
  await waitForLivePolicyUpdate({});
});
