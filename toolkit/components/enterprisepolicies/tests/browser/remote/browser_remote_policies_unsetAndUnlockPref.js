/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { setAndLockPref, unsetAndUnlockPref } = ChromeUtils.importESModule(
  "resource:///modules/policies/Policies.sys.mjs"
);

const PREF_VALUE = {
  DEFAULT: "default",
  USER_CHANGED: "user-changed",
  POLICY_DEFAULT: "policy-default",
  POLICY_CHANGED: "policy-changed",
}

const prefName = "browser.tests.some_random_pref";

add_setup(async () => {
  registerCleanupFunction(() => {
    Services.prefs.deleteBranch(prefName);
  });
})

/**
 * Tests that the initial preference state (default and user value) is restored 
 * when unsetting and unlocking a preference via unsetAndUnlockPref 
 * 
 * Test flow:
 * 
 * 0. Verify that we are starting with a clean preference state.
 * 1. Setting user and default values
 * 2. Changing the user value
 * 3. Calling setAndUnlockPref which overriddes the preference's default and user value.
 * 4. Calling setAndUnlockPref again with a different value.
 * 5. Call unsetAndUnlockPref which should restore the preference's initial state.
 */
add_task(async function test_unsetAndUnlockPref() {

  // 0. Verify that we are starting with a clean preference state.
  try {
    Services.prefs.getStringPref(prefName);
    ok(false, `Pref ${prefName} exists, this should not happen`);
  } catch {
    ok(true, `Pref ${prefName} does not exist`);
  }

  // 1. Setting user and default values
  let defaults = Services.prefs.getDefaultBranch("");
  defaults.setStringPref(prefName, PREF_VALUE.DEFAULT);

  info("Verify the preference's default value is set.")
  is(
    Services.prefs.getStringPref(prefName),
    PREF_VALUE.DEFAULT,
    "Correct default pref value returned via Services.prefs."
  );
  info("Verify the preference's user value is set.")
  is(
    defaults.getStringPref(prefName),
    PREF_VALUE.DEFAULT,
    "Correct default pref value returned via defaults."
  );

  // 2. Changing the user value
  Services.prefs.setStringPref(prefName, PREF_VALUE.USER_CHANGED);

  info("Verify the preference's user value is changed.")
  is(
    Services.prefs.getStringPref(prefName),
    PREF_VALUE.USER_CHANGED,
    "user pref value returned via Services.prefs."
  );
  info("Verify the preference's default value has not changed.")
  is(
    defaults.getStringPref(prefName),
    PREF_VALUE.DEFAULT,
    "default pref value returned via defaults."
  );

  info("Verify the preference is not locked.")
  is(
    false,
    Services.prefs.prefIsLocked(prefName),
    "Pref reports as not locked"
  );

  // 3. Calling setAndUnlockPref which overriddes a preference's default and user value once.
  setAndLockPref(prefName, PREF_VALUE.POLICY_DEFAULT);

  info("Verify the preference's user value was overridden by the policy.")
  is(
    Services.prefs.getStringPref(prefName),
    PREF_VALUE.POLICY_DEFAULT,
    "new default pref value returned via Services.prefs."
  );
  info("Verify the preference's default value was overridden by the policy.")
  is(
    defaults.getStringPref(prefName),
    PREF_VALUE.POLICY_DEFAULT,
    "new default pref value returned via defaults."
  );
  info("Verify the preference is locked.")
  is(true, Services.prefs.prefIsLocked(prefName), "Pref reports as locked");

  // 4. Calling setAndUnlockPref again with a different value.
  setAndLockPref(prefName, PREF_VALUE.POLICY_CHANGED);

  info("Verify the preference's user value was overridden another time by the policy update.")
  is(
    Services.prefs.getStringPref(prefName),
    PREF_VALUE.POLICY_CHANGED,
    "new changed pref value returned via Services.prefs."
  );
  info("Verify the preference's default value was overridden another time by the policy update.")
  is(
    defaults.getStringPref(prefName),
    PREF_VALUE.POLICY_CHANGED,
    "new changed pref value returned via defaults."
  );
  info("Verify the preference remains locked.")
  is(true, Services.prefs.prefIsLocked(prefName), "Pref remains as locked");

  // 5. Call unsetAndUnlockPref which should restore the preference's initial state.
  unsetAndUnlockPref(prefName)

  info("Verify the preference's initial changed user value is restored.");
  is(
    Services.prefs.getStringPref(prefName),
    PREF_VALUE.USER_CHANGED,
    "original user pref value returned via Services.prefs."
  );
  info("Verify the preference's initial default value is restored.");
  is(
    defaults.getStringPref(prefName),
    PREF_VALUE.DEFAULT,
    "original default pref value returned via defaults."
  );
  info("Verify the preference is unlocked again.")
  is(false, Services.prefs.prefIsLocked(prefName), "Pref reports as unlocked");
});

