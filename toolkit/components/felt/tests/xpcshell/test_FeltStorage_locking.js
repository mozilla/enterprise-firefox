/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tests for the locked-session token accessors that FeltLocking relies on to
// persist refresh tokens in felt.json instead of a pref. FeltStorage owns the
// encryption, so OSKeyStore is stubbed to a reversible transform here.

// Imported lazily so FeltStorage doesn't resolve its "UAppData"-based path
// before makeFakeAppDir() runs in the head.js add_setup().
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FeltStorage: "resource://gre/modules/enterprise/FeltStorage.sys.mjs",
});

const { OSKeyStore } = ChromeUtils.importESModule(
  "resource://gre/modules/OSKeyStore.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const EMAIL_A = "a@example.com";
const EMAIL_B = "b@example.com";

add_setup(async function () {
  do_get_profile();
  await lazy.FeltStorage.init();

  // Reversible stand-ins so the tests can assert both that a value is encrypted
  // on the way in and recovered on the way out, without a real keystore.
  sinon
    .stub(OSKeyStore, "encrypt")
    .callsFake(async plaintext => `enc(${plaintext})`);
  sinon
    .stub(OSKeyStore, "decrypt")
    .callsFake(async ciphertext => ciphertext.replace(/^enc\((.*)\)$/, "$1"));

  registerCleanupFunction(() => {
    sinon.restore();
  });
});

add_task(async function test_get_returns_undefined_initially() {
  Assert.equal(
    await lazy.FeltStorage.getLockingToken(EMAIL_A),
    undefined,
    "no token stored for an unknown user"
  );
  Assert.equal(
    lazy.FeltStorage.hasLockingToken(EMAIL_A),
    false,
    "hasLockingToken is false for an unknown user"
  );
});

add_task(async function test_set_get_update_clear_roundtrip() {
  await lazy.FeltStorage.setLockingToken(EMAIL_A, "token-1");
  Assert.ok(
    lazy.FeltStorage.hasLockingToken(EMAIL_A),
    "hasLockingToken is true once a token is stored"
  );
  Assert.equal(
    await lazy.FeltStorage.getLockingToken(EMAIL_A),
    "token-1",
    "the stored token round-trips through encrypt/decrypt"
  );

  await lazy.FeltStorage.setLockingToken(EMAIL_A, "token-2");
  Assert.equal(
    await lazy.FeltStorage.getLockingToken(EMAIL_A),
    "token-2",
    "token is overwritten on a second set"
  );

  lazy.FeltStorage.clearLockingToken(EMAIL_A);
  Assert.equal(
    await lazy.FeltStorage.getLockingToken(EMAIL_A),
    undefined,
    "token is removed after clear"
  );
});

add_task(async function test_stored_value_is_encrypted_at_rest() {
  await lazy.FeltStorage.setLockingToken(EMAIL_A, "plaintext");
  Assert.equal(
    lazy.FeltStorage._feltStorage.data.lockingTokens[EMAIL_A].token,
    "enc(plaintext)",
    "the raw token persisted to felt.json is the ciphertext, never the plaintext"
  );
  lazy.FeltStorage.clearLockingToken(EMAIL_A);
});

add_task(async function test_user_id_stored_and_preserved_on_rotation() {
  await lazy.FeltStorage.setLockingToken(EMAIL_A, "token-1", "user-123");
  Assert.equal(
    lazy.FeltStorage.getLockingUserId(EMAIL_A),
    "user-123",
    "the user id is stored alongside the token"
  );

  await lazy.FeltStorage.setLockingToken(EMAIL_A, "token-2");
  Assert.equal(
    await lazy.FeltStorage.getLockingToken(EMAIL_A),
    "token-2",
    "the token is rotated"
  );
  Assert.equal(
    lazy.FeltStorage.getLockingUserId(EMAIL_A),
    "user-123",
    "the user id is preserved when the token is rotated without one"
  );

  lazy.FeltStorage.clearLockingToken(EMAIL_A);
  Assert.equal(
    lazy.FeltStorage.getLockingUserId(EMAIL_A),
    undefined,
    "clearing the token drops the user id too"
  );
});

add_task(async function test_tokens_are_isolated_per_email() {
  await lazy.FeltStorage.setLockingToken(EMAIL_A, "token-a");
  await lazy.FeltStorage.setLockingToken(EMAIL_B, "token-b");

  Assert.equal(await lazy.FeltStorage.getLockingToken(EMAIL_A), "token-a");
  Assert.equal(await lazy.FeltStorage.getLockingToken(EMAIL_B), "token-b");

  lazy.FeltStorage.clearLockingToken(EMAIL_A);
  Assert.equal(
    await lazy.FeltStorage.getLockingToken(EMAIL_A),
    undefined,
    "clearing one user does not affect the other"
  );
  Assert.equal(
    await lazy.FeltStorage.getLockingToken(EMAIL_B),
    "token-b",
    "the other user's token is untouched"
  );

  lazy.FeltStorage.clearLockingToken(EMAIL_B);
});

add_task(async function test_clear_missing_is_noop() {
  // Clearing a token that was never stored must not throw.
  lazy.FeltStorage.clearLockingToken("nobody@example.com");
  Assert.ok(true, "clearing a missing token did not throw");
});

add_task(async function test_tokens_persist_across_reload() {
  await lazy.FeltStorage.setLockingToken(EMAIL_A, "persisted");

  // Flush pending writes and reload the backing file from disk.
  await lazy.FeltStorage._feltStorage._save();
  await lazy.FeltStorage.init();

  Assert.equal(
    await lazy.FeltStorage.getLockingToken(EMAIL_A),
    "persisted",
    "token survives a save + reload cycle"
  );

  lazy.FeltStorage.clearLockingToken(EMAIL_A);
});
