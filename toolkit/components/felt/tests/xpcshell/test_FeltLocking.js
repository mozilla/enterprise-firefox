/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tests for the FeltLocking store/clear/enabled surface. tryUnlock is not
// covered here because it depends on Services.felt and ConsoleClient, which
// require a running FELT instance; the storage and encryption behavior of the
// remaining entry points is exercised below with OSKeyStore stubbed.

const { FeltLocking } = ChromeUtils.importESModule(
  "chrome://felt/content/FeltLocking.sys.mjs"
);
const { FeltStorage } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/FeltStorage.sys.mjs"
);
const { OSKeyStore } = ChromeUtils.importESModule(
  "resource://gre/modules/OSKeyStore.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const ENABLED_PREF = "enterprise.session.locking.enabled";
const EMAIL = "user@example.com";

add_setup(async function () {
  do_get_profile();
  await FeltStorage.init();
  FeltStorage.updateLastSignedInUserEmail(EMAIL);

  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(ENABLED_PREF);
    FeltStorage.clearLockingToken(EMAIL);
  });
});

add_task(async function test_enabled_reflects_pref() {
  Services.prefs.setBoolPref(ENABLED_PREF, false);
  Assert.equal(FeltLocking.enabled, false, "disabled when pref is false");

  Services.prefs.setBoolPref(ENABLED_PREF, true);
  Assert.equal(FeltLocking.enabled, true, "enabled when pref is true");
});

add_task(async function test_store_is_noop_when_disabled() {
  Services.prefs.setBoolPref(ENABLED_PREF, false);
  const encrypt = sinon.stub(OSKeyStore, "encrypt");
  try {
    await FeltLocking.store("refresh-token");
    Assert.ok(encrypt.notCalled, "does not encrypt when locking is disabled");
    Assert.equal(
      FeltStorage.getLockingToken(EMAIL),
      undefined,
      "nothing is persisted when locking is disabled"
    );
  } finally {
    encrypt.restore();
  }
});

add_task(async function test_store_encrypts_and_persists() {
  Services.prefs.setBoolPref(ENABLED_PREF, true);
  FeltStorage.updateLastSignedInUserEmail(EMAIL);
  const encrypt = sinon
    .stub(OSKeyStore, "encrypt")
    .resolves("encrypted(refresh-token)");
  try {
    await FeltLocking.store("refresh-token");
    Assert.ok(
      encrypt.calledOnceWithExactly("refresh-token"),
      "encrypts the plaintext refresh token"
    );
    Assert.equal(
      FeltStorage.getLockingToken(EMAIL),
      "encrypted(refresh-token)",
      "persists the ciphertext keyed by the current user"
    );
  } finally {
    encrypt.restore();
    FeltStorage.clearLockingToken(EMAIL);
  }
});

add_task(async function test_store_throws_when_no_user_known() {
  Services.prefs.setBoolPref(ENABLED_PREF, true);
  FeltStorage.updateLastSignedInUserEmail(undefined);
  const encrypt = sinon.stub(OSKeyStore, "encrypt");
  try {
    await Assert.rejects(
      FeltLocking.store("refresh-token"),
      /no signed-in user/,
      "rejects so the caller can fall back to signing out"
    );
    Assert.ok(encrypt.notCalled, "does not encrypt when no user is known");
  } finally {
    encrypt.restore();
    FeltStorage.updateLastSignedInUserEmail(EMAIL);
  }
});

add_task(async function test_clear_removes_stored_token() {
  Services.prefs.setBoolPref(ENABLED_PREF, true);
  FeltStorage.updateLastSignedInUserEmail(EMAIL);
  FeltStorage.setLockingToken(EMAIL, "ciphertext");

  await FeltLocking.clear();

  Assert.equal(
    FeltStorage.getLockingToken(EMAIL),
    undefined,
    "clear removes the stored token"
  );
});

add_task(async function test_clear_runs_even_when_disabled() {
  // Signing out must never leave a token behind, even if locking was turned
  // off after a session was locked.
  Services.prefs.setBoolPref(ENABLED_PREF, false);
  FeltStorage.updateLastSignedInUserEmail(EMAIL);
  FeltStorage.setLockingToken(EMAIL, "ciphertext");

  await FeltLocking.clear();

  Assert.equal(
    FeltStorage.getLockingToken(EMAIL),
    undefined,
    "clear removes the token regardless of the enabled pref"
  );
});
