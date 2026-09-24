/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PASSWORDS_PREF = "services.sync.engine.passwords";
const CREDITCARDS_PREF = "services.sync.engine.creditcards";
const BOOKMARKS_PREF = "services.sync.engine.bookmarks";

registerCleanupFunction(async function () {
  await setupPolicyEngineWithJson({});
});

add_task(async function test_locked_policy_engine_states() {
  await setupPolicyEngineWithJson({
    policies: {
      Sync: {
        Locked: true,
        Bookmarks: true,
        Passwords: true,
        PaymentMethods: false,
      },
    },
  });

  // A non-sensitive engine is locked on as requested.
  ok(Services.prefs.prefIsLocked(BOOKMARKS_PREF), "Bookmarks engine is locked");
  is(
    Services.prefs.getBoolPref(BOOKMARKS_PREF),
    true,
    "Bookmarks engine is turned on"
  );

  // Passwords cannot be forced on: the request is ignored and the pref stays
  // unlocked, so the checkbox stays editable for the user to opt in.
  ok(
    !Services.prefs.prefIsLocked(PASSWORDS_PREF),
    "Passwords engine stays unlocked despite the locked policy"
  );

  // Payment methods can be forced off (and locked).
  ok(
    Services.prefs.prefIsLocked(CREDITCARDS_PREF),
    "Payment methods engine is locked"
  );
  is(
    Services.prefs.getBoolPref(CREDITCARDS_PREF),
    false,
    "Payment methods engine is turned off"
  );
});

add_task(async function test_locked_enabled_disallows_change_sync_state() {
  await setupPolicyEngineWithJson({
    policies: {
      Sync: {
        Enabled: false,
        Locked: true,
      },
    },
  });

  ok(
    !Services.policies.isAllowed("change-sync-state"),
    "change-sync-state is disallowed when the policy locks the Enabled state"
  );
});
