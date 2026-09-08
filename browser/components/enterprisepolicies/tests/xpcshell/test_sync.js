/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PASSWORDS_PREF = "services.sync.engine.passwords";
const CREDITCARDS_PREF = "services.sync.engine.creditcards";
const BOOKMARKS_PREF = "services.sync.engine.bookmarks";

add_task(async function test_sync_cannot_force_enable_sensitive_engines() {
  await setupPolicyEngineWithJson({
    policies: {
      Sync: {
        Passwords: true,
        PaymentMethods: true,
      },
    },
  });

  // A policy request to enable passwords / payment methods must be ignored:
  // the prefs stay unlocked and the engines stay off (enterprise default).
  ok(
    !Services.prefs.prefIsLocked(PASSWORDS_PREF),
    "Passwords engine is not locked by the policy"
  );
  ok(
    !Services.prefs.prefIsLocked(CREDITCARDS_PREF),
    "Payment methods engine is not locked by the policy"
  );
  strictEqual(
    Preferences.get(PASSWORDS_PREF),
    false,
    "Passwords engine stays off despite the policy asking to enable it"
  );
  strictEqual(
    Preferences.get(CREDITCARDS_PREF),
    false,
    "Payment methods engine stays off despite the policy asking to enable it"
  );

  // The user is still free to opt in locally.
  Services.prefs.setBoolPref(PASSWORDS_PREF, true);
  strictEqual(
    Preferences.get(PASSWORDS_PREF),
    true,
    "User can still enable passwords sync locally"
  );
  Services.prefs.clearUserPref(PASSWORDS_PREF);
});

add_task(async function test_sync_can_disable_sensitive_engines() {
  await setupPolicyEngineWithJson({
    policies: {
      Sync: {
        Passwords: false,
        PaymentMethods: false,
      },
    },
  });

  // Disabling is allowed, and follows the usual `Locked` handling: without it,
  // the policy only sets an overridable default.
  ok(
    !Services.prefs.prefIsLocked(PASSWORDS_PREF),
    "Passwords engine is not locked when the policy is not locked"
  );
  ok(
    !Services.prefs.prefIsLocked(CREDITCARDS_PREF),
    "Payment methods engine is not locked when the policy is not locked"
  );
  checkDefaultPref(PASSWORDS_PREF, false);
  checkDefaultPref(CREDITCARDS_PREF, false);
});

add_task(async function test_sync_can_lock_off_sensitive_engines() {
  await setupPolicyEngineWithJson({
    policies: {
      Sync: {
        Locked: true,
        Passwords: false,
        PaymentMethods: false,
      },
    },
  });

  // With `Locked`, disabling is enforced and the user cannot turn it back on.
  checkLockedPref(PASSWORDS_PREF, false);
  checkLockedPref(CREDITCARDS_PREF, false);
});

add_task(async function test_sync_locked_policy_cannot_force_enable() {
  await setupPolicyEngineWithJson({
    policies: {
      Sync: {
        Locked: true,
        Passwords: true,
        PaymentMethods: true,
      },
    },
  });

  // Even a locked policy cannot force these on, and must leave the prefs
  // unlocked so the user is still free to opt in.
  ok(
    !Services.prefs.prefIsLocked(PASSWORDS_PREF),
    "Passwords engine stays unlocked despite the locked policy"
  );
  ok(
    !Services.prefs.prefIsLocked(CREDITCARDS_PREF),
    "Payment methods engine stays unlocked despite the locked policy"
  );
  strictEqual(
    Preferences.get(PASSWORDS_PREF),
    false,
    "Passwords engine stays off despite the locked policy asking to enable it"
  );
});

add_task(async function test_sync_reapply_restores_unlocked_state() {
  // Start from the force-disabled (locked) state.
  await setupPolicyEngineWithJson({
    policies: {
      Sync: {
        Locked: true,
        Passwords: false,
        PaymentMethods: false,
      },
    },
  });
  ok(Services.prefs.prefIsLocked(PASSWORDS_PREF), "Precondition: locked off");

  // Re-applying the policy first restores the previous state; a subsequent
  // request to enable is ignored, leaving the prefs unlocked again.
  await setupPolicyEngineWithJson({
    policies: {
      Sync: {
        Passwords: true,
        PaymentMethods: true,
      },
    },
  });
  ok(
    !Services.prefs.prefIsLocked(PASSWORDS_PREF),
    "Passwords pref is unlocked again after re-applying the policy"
  );
  ok(
    !Services.prefs.prefIsLocked(CREDITCARDS_PREF),
    "Payment methods pref is unlocked again after re-applying the policy"
  );
});

add_task(async function test_sync_non_sensitive_engine_default_without_lock() {
  await setupPolicyEngineWithJson({
    policies: {
      Sync: {
        Bookmarks: false,
      },
    },
  });

  // Without `Locked`, other engines get an overridable default, not a lock.
  ok(
    !Services.prefs.prefIsLocked(BOOKMARKS_PREF),
    "Bookmarks engine is not locked when the policy is not locked"
  );
  checkDefaultPref(BOOKMARKS_PREF, false);
});
