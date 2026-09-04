/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PREF_NAME = "enterprise.locking.browser_close";

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
