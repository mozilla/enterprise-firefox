/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Coverage matrix for restorePreferenceState — each row is the pref state
 * before the policy was applied combined with whether the policy locks.
 *
 * | default | user | locks | post-restore expectation                          |
 * |---------|------|-------|---------------------------------------------------|
 * | set     | set  | yes   | default + user value restored                     |
 * | set     | set  | no    | default restored; user value untouched            |
 * | set     | null | yes   | default restored; mid-policy user value cleared   |
 * | set     | null | no    | default restored; mid-policy user value preserved |
 * | null    | set  | yes   | default removed; initial user value restored      |
 * | null    | set  | no    | default removed; user value preserved             |
 * | null    | null | yes   | preference removed entirely                       |
 * | null    | null | no    | default removed; mid-policy user value preserved  |
 *
 * Plus: test_only_initial_preference_state_cached_and_restored — verifies
 * that repeated setDefaultPref calls don't overwrite the cached initial state.
 *
 * Plus: test_restore_cached_user_value_when_no_initial_default_value_and_user_value_cleared_mid_policy —
 * verifies the (null, set, yes) row when the user value is cleared mid-policy:
 * the cached snapshot wins over the (now-missing) current user value.
 *
 * Note: the policy engine cannot correctly restore preference state across
 * browser restarts. _initialPrefState lives only in memory, so the cached
 * pre-policy values are lost on shutdown; any policy applied in a previous
 * session can no longer be cleanly undone.
 */

"use strict";

const { PoliciesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PoliciesHelpers.sys.mjs"
);

const PREF_VALUE = {
  INITIAL_DEFAULT: "initial-default-value",
  INITIAL_USER: "initial-user-value",
  USER_CHANGED: "user-changed",
  POLICY_DEFAULT: "policy-default",
  POLICY_CHANGED: "policy-changed",
};

const prefName = "browser.tests.some_random_pref";

function assert_clean_preference_state() {
  info(
    "Verifying we are starting with a clean preference state, hence no default or user value"
  );
  ok(!Services.prefs.prefHasDefaultValue(prefName), "No default value");
  ok(!Services.prefs.prefHasUserValue(prefName), "No user value");

  // Resetting the preference state cache
  PoliciesUtils._initialPrefState = {};
}

/**
 * Restoring the preference state (default and user value cached) when the
 * preference was locked restores both default and user value.
 */
add_task(
  async function test_restore_default_and_user_value_when_preference_locked() {
    assert_clean_preference_state();

    const defaults = Services.prefs.getDefaultBranch("");

    info("Setting preference's default and user value");
    defaults.setStringPref(prefName, PREF_VALUE.INITIAL_DEFAULT);
    Services.prefs.setStringPref(prefName, PREF_VALUE.INITIAL_USER);

    info(
      "Set the preference's default value to the policy value and lock the preference"
    );
    PoliciesUtils.setAndLockPref(prefName, PREF_VALUE.POLICY_DEFAULT);

    info("Verifying that the policy value is applied");
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.POLICY_DEFAULT,
      "Expected policy value to be returned as default"
    );

    info(
      "Verifying that the policy default value is returned as user value, since the preference is locked"
    );
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.POLICY_DEFAULT,
      "Expected policy value to be returned as user value"
    );

    info("Verifying that the policy is locked");
    ok(Services.prefs.prefIsLocked(prefName), "Preference is locked");

    info("Modifying the user value on a locked preference");
    Services.prefs.setStringPref(prefName, PREF_VALUE.USER_CHANGED);

    info(
      "Verifying that the policy default value is still returned even after the user value was directly modified"
    );
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.POLICY_DEFAULT,
      "Expected policy value to be returned even after user value changed"
    );

    info("Restoring preference state");
    PoliciesUtils.unsetAndUnlockPref(prefName);

    info("Verifying that the initial default value is restored");
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.INITIAL_DEFAULT,
      "Expected default value to be restored"
    );

    info(
      "Verifying that the initial user value is returned, since the preference is unlocked again"
    );
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.INITIAL_USER,
      "Expected user value to be restored."
    );

    info("Verifying that the policy is unlocked again");
    ok(!Services.prefs.prefIsLocked(prefName), "Preference is unlocked");

    Services.prefs.deleteBranch(prefName);
  }
);

/**
 * Restoring the preference state (default and user value cached) when the
 * preference wasn't locked restores only the default value.
 */
add_task(
  async function test_restore_only_default_value_when_preference_unlocked() {
    assert_clean_preference_state();

    const defaults = Services.prefs.getDefaultBranch("");

    info("Setting preference's default and user value");
    defaults.setStringPref(prefName, PREF_VALUE.INITIAL_DEFAULT);
    Services.prefs.setStringPref(prefName, PREF_VALUE.INITIAL_USER);

    info("Set the preference's default value to the policy value");
    PoliciesUtils.setDefaultPref(prefName, PREF_VALUE.POLICY_DEFAULT);

    info("Verifying that the policy value is applied");
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.POLICY_DEFAULT,
      "Expected policy value to be returned as default"
    );

    info(
      "Verifying that the user value is unchanged, since the preference is not locked"
    );
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.INITIAL_USER,
      "Expected user value to remain untouched"
    );

    info("Restoring preference state");
    PoliciesUtils.unsetDefaultPref(prefName);

    info("Verifying that the initial default value is restored");
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.INITIAL_DEFAULT,
      "Expected default value to be restored"
    );

    Services.prefs.deleteBranch(prefName);
  }
);

/**
 * Restoring the preference state when no initial user value existed and the
 * policy was locking. The initial default value is restored and any user
 * value added during the policy's lifetime gets cleared.
 */
add_task(
  async function test_clear_user_value_when_no_initial_user_value_and_preference_locked() {
    assert_clean_preference_state();

    const defaults = Services.prefs.getDefaultBranch("");

    info("Setting preference's default value (no user value)");
    defaults.setStringPref(prefName, PREF_VALUE.INITIAL_DEFAULT);
    ok(!Services.prefs.prefHasUserValue(prefName), "No initial user value");

    info(
      "Set the preference's default value to the policy value and lock the preference"
    );
    PoliciesUtils.setAndLockPref(prefName, PREF_VALUE.POLICY_DEFAULT);

    info("Verifying that the policy value is applied");
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.POLICY_DEFAULT,
      "Expected policy value to be returned as default"
    );

    info("Verifying that the policy is locked");
    ok(Services.prefs.prefIsLocked(prefName), "Preference is locked");

    info("Setting a user value while the policy is active");
    Services.prefs.setStringPref(prefName, PREF_VALUE.USER_CHANGED);

    info("Restoring preference state");
    PoliciesUtils.unsetAndUnlockPref(prefName);

    info("Verifying that the initial default value is restored");
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.INITIAL_DEFAULT,
      "Expected default value to be restored"
    );

    info(
      "Verifying that no user value remains, since none existed before the policy was applied and the policy was locking"
    );
    ok(!Services.prefs.prefHasUserValue(prefName), "Expected no user value");

    info("Verifying that the preference is unlocked again");
    ok(!Services.prefs.prefIsLocked(prefName), "Preference is unlocked");

    Services.prefs.deleteBranch(prefName);
  }
);

/**
 * Restoring the preference state when no initial user value existed and the
 * policy wasn't locking. The initial default value is restored and any user
 * value added during the policy's lifetime is preserved.
 */
add_task(
  async function test_restore_default_value_when_no_initial_user_value_and_preference_unlocked() {
    assert_clean_preference_state();

    const defaults = Services.prefs.getDefaultBranch("");

    info("Setting preference's default value (no user value)");
    defaults.setStringPref(prefName, PREF_VALUE.INITIAL_DEFAULT);
    ok(!Services.prefs.prefHasUserValue(prefName), "No initial user value");

    info("Set the preference's default value to the policy value");
    PoliciesUtils.setDefaultPref(prefName, PREF_VALUE.POLICY_DEFAULT);

    info("Verifying that the policy value is applied");
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.POLICY_DEFAULT,
      "Expected policy value to be returned as default"
    );

    info("Setting a user value while the policy is active (unlocked)");
    Services.prefs.setStringPref(prefName, PREF_VALUE.USER_CHANGED);

    info("Restoring preference state");
    PoliciesUtils.unsetDefaultPref(prefName);

    info("Verifying that the initial default value is restored");
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.INITIAL_DEFAULT,
      "Expected default value to be restored"
    );

    info(
      "Verifying that the mid-policy user value is preserved, since the policy was unlocked"
    );
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.USER_CHANGED,
      "Expected user value to remain"
    );

    Services.prefs.deleteBranch(prefName);
  }
);

/**
 * Restoring the preference state (no values cached) when the
 * preference was locked restores both default and user value,
 * hence the preference gets removed again.
 */
add_task(
  async function test_remove_preference_if_no_default_or_user_value_to_restore_and_preference_locked() {
    assert_clean_preference_state();

    const defaults = Services.prefs.getDefaultBranch("");

    info(
      "Set the preference's default value to the policy value and lock the preference"
    );
    PoliciesUtils.setAndLockPref(prefName, PREF_VALUE.POLICY_DEFAULT);

    info("Verifying that the policy value is applied");
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.POLICY_DEFAULT,
      "Expected policy value to be returned as default"
    );

    info(
      "Verifying that the policy default value is returned as user value, since the preference is locked"
    );
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.POLICY_DEFAULT,
      "Expected policy value to be returned as user value"
    );

    info("Verifying that the policy is locked");
    ok(Services.prefs.prefIsLocked(prefName), "Preference is locked");

    info("Restoring preference state");
    PoliciesUtils.unsetAndUnlockPref(prefName);

    info(
      "Verifying that there is no default value since the preference was removed"
    );
    ok(
      !Services.prefs.prefHasDefaultValue(prefName),
      "No default value since preference was removed"
    );

    info(
      "Verifying that there is no user value since the preference was removed"
    );
    ok(
      !Services.prefs.prefHasUserValue(prefName),
      "No user value since preference was removed"
    );
  }
);

/**
 * Restoring the preference state when only a user value was cached (no initial
 * default value) and the preference was locked restores the user value and
 * removes the policy-set default value.
 */
add_task(
  async function test_restore_user_value_when_no_initial_default_value_and_preference_locked() {
    assert_clean_preference_state();

    const defaults = Services.prefs.getDefaultBranch("");

    info("Setting preference's user value (no default value)");
    Services.prefs.setStringPref(prefName, PREF_VALUE.INITIAL_USER);

    ok(
      !Services.prefs.prefHasDefaultValue(prefName),
      "No initial default value"
    );

    info(
      "Set the preference's default value to the policy value and lock the preference"
    );
    PoliciesUtils.setAndLockPref(prefName, PREF_VALUE.POLICY_DEFAULT);

    info("Verifying that the policy value is applied");
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.POLICY_DEFAULT,
      "Expected policy value to be returned as default"
    );

    info("Verifying that the policy is locked");
    ok(Services.prefs.prefIsLocked(prefName), "Preference is locked");

    info("Restoring preference state");
    PoliciesUtils.unsetAndUnlockPref(prefName);

    info(
      "Verifying that there is no default value, since none existed before the policy was applied"
    );
    ok(
      !Services.prefs.prefHasDefaultValue(prefName),
      "Expected no default value"
    );

    info(
      "Verifying that the initial user value is restored, since the preference was locked"
    );
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.INITIAL_USER,
      "Expected user value to be restored"
    );

    info("Verifying that the preference is unlocked again");
    ok(!Services.prefs.prefIsLocked(prefName), "Preference is unlocked");

    Services.prefs.deleteBranch(prefName);
  }
);

/**
 * Restoring the preference state when only a user value was cached (no initial
 * default value), the policy was locked, and the user value was cleared
 * during the policy's lifetime. Only the cached user value is restored.
 */
add_task(
  async function test_restore_cached_user_value_when_no_initial_default_value_and_user_value_cleared_mid_policy() {
    assert_clean_preference_state();

    info("Setting preference's user value (no default value)");
    Services.prefs.setStringPref(prefName, PREF_VALUE.INITIAL_USER);
    ok(
      !Services.prefs.prefHasDefaultValue(prefName),
      "No initial default value"
    );

    info(
      "Set the preference's default value to the policy value and lock the preference"
    );
    PoliciesUtils.setAndLockPref(prefName, PREF_VALUE.POLICY_DEFAULT);

    info("Verifying that the policy is locked");
    ok(Services.prefs.prefIsLocked(prefName), "Preference is locked");

    info("Clearing the user value while the policy is active");
    Services.prefs.clearUserPref(prefName);
    ok(!Services.prefs.prefHasUserValue(prefName), "No user value mid-policy");

    info("Restoring preference state");
    PoliciesUtils.unsetAndUnlockPref(prefName);

    info(
      "Verifying that there is no default value, since none existed before the policy was applied"
    );
    ok(
      !Services.prefs.prefHasDefaultValue(prefName),
      "Expected no default value"
    );

    info(
      "Verifying that the cached user value is restored, since the policy was locked"
    );
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.INITIAL_USER,
      "Expected cached user value to be restored"
    );

    info("Verifying that the preference is unlocked again");
    ok(!Services.prefs.prefIsLocked(prefName), "Preference is unlocked");

    Services.prefs.deleteBranch(prefName);
  }
);

/**
 * Restoring the preference state when only a user value was cached (no initial
 * default value) and the policy wasn't locking. The policy-set default is
 * removed and the user value is preserved.
 */
add_task(
  async function test_restore_user_value_when_no_initial_default_value_and_preference_unlocked() {
    assert_clean_preference_state();

    const defaults = Services.prefs.getDefaultBranch("");

    info("Setting preference's user value (no default value)");
    Services.prefs.setStringPref(prefName, PREF_VALUE.INITIAL_USER);
    ok(
      !Services.prefs.prefHasDefaultValue(prefName),
      "No initial default value"
    );

    info("Set the preference's default value to the policy value");
    PoliciesUtils.setDefaultPref(prefName, PREF_VALUE.POLICY_DEFAULT);

    info("Verifying that the policy default is applied");
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.POLICY_DEFAULT,
      "Expected policy value to be returned as default"
    );

    info(
      "Verifying that the user value is unchanged, since the preference is not locked"
    );
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.INITIAL_USER,
      "Expected user value to remain untouched"
    );

    info("Restoring preference state");
    PoliciesUtils.unsetDefaultPref(prefName);

    info(
      "Verifying that there is no default value, since none existed before the policy was applied"
    );
    ok(
      !Services.prefs.prefHasDefaultValue(prefName),
      "Expected no default value"
    );

    info("Verifying that the initial user value is preserved");
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.INITIAL_USER,
      "Expected user value to be preserved"
    );

    Services.prefs.deleteBranch(prefName);
  }
);

/**
 *
 * Restoring the preference state (no values cached) when the
 * preference wasn't locked restores only the default value,
 * hence the default value is removed.
 */
add_task(
  async function test_only_default_value_restored_when_no_default_or_user_value_to_restore_and_preference_unlocked() {
    assert_clean_preference_state();

    const defaults = Services.prefs.getDefaultBranch("");

    info("Set the preference's default value to the policy value");
    PoliciesUtils.setDefaultPref(prefName, PREF_VALUE.POLICY_DEFAULT);

    info("Verifying that the policy value is applied");
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.POLICY_DEFAULT,
      "Expected policy value to be returned as default"
    );

    info(
      "Verifying that the policy default value is returned for non-existing user value"
    );
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.POLICY_DEFAULT,
      "Expected policy value to be returned as user value"
    );

    Services.prefs.setStringPref(prefName, PREF_VALUE.USER_CHANGED);

    info("Verifying that the user value is changed.");
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.USER_CHANGED,
      "Expected non-default user value to be returned"
    );

    info("Restoring preference state");
    PoliciesUtils.unsetDefaultPref(prefName);

    info(
      "Verifying that there is no default value since the preference was removed"
    );
    ok(
      !Services.prefs.prefHasDefaultValue(prefName),
      "Expected default value to be removed"
    );

    info(
      "Verifying that the user value remains unchanged as the preference was unlocked"
    );
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.USER_CHANGED,
      "Expected user value to remain unchanged"
    );

    Services.prefs.deleteBranch(prefName);
  }
);

/**
 * Verifying that only the initial preference state is cached and restored
 * even if PoliciesUtils.setDefaultPref is called more than once.
 */
add_task(
  async function test_only_initial_preference_state_cached_and_restored() {
    assert_clean_preference_state();

    const defaults = Services.prefs.getDefaultBranch("");

    info("Setting preference's default and user value");
    defaults.setStringPref(prefName, PREF_VALUE.INITIAL_DEFAULT);
    Services.prefs.setStringPref(prefName, PREF_VALUE.INITIAL_USER);

    info("Set the preference's default value to the policy value");
    PoliciesUtils.setDefaultPref(prefName, PREF_VALUE.POLICY_DEFAULT);

    info("Verifying that the policy value is applied");
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.POLICY_DEFAULT,
      "Expected policy value to be returned as default"
    );

    info(
      "Verifying that the user value is unchanged, since the preference is not locked"
    );
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.INITIAL_USER,
      "Expected user value to remain untouched"
    );

    info("Overriding the preference's default value");
    PoliciesUtils.setDefaultPref(prefName, PREF_VALUE.POLICY_CHANGED);

    info("Verifying that the policy default value is updated");
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.POLICY_CHANGED,
      "Expected updated policy value to be returned as default"
    );

    info(
      "Verifying that the user value is unchanged, since the preference is not locked"
    );
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.INITIAL_USER,
      "Expected user value to remain untouched"
    );

    info("Restoring preference state");
    PoliciesUtils.unsetDefaultPref(prefName);

    info(
      "Verifying that the initial default value is restored, because preference state was only cached once"
    );
    Assert.equal(
      defaults.getStringPref(prefName),
      PREF_VALUE.INITIAL_DEFAULT,
      "Expected default value to be restored"
    );

    info(
      "Verifying that the user value is unchanged, since the preference is not locked"
    );
    Assert.equal(
      Services.prefs.getStringPref(prefName),
      PREF_VALUE.INITIAL_USER,
      "Expected user value to be restored."
    );

    Services.prefs.deleteBranch(prefName);
  }
);
