/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tests for the locked-session token accessors that FeltLocking relies on to
// persist (encrypted) refresh tokens in felt.json instead of a pref.

// Imported lazily so FeltStorage doesn't resolve its "UAppData"-based path
// before makeFakeAppDir() runs in the head.js add_setup().
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FeltStorage: "resource://gre/modules/enterprise/FeltStorage.sys.mjs",
});

const EMAIL_A = "a@example.com";
const EMAIL_B = "b@example.com";

add_setup(async function () {
  do_get_profile();
  await lazy.FeltStorage.init();
});

add_task(async function test_get_returns_undefined_initially() {
  Assert.equal(
    lazy.FeltStorage.getLockingToken(EMAIL_A),
    undefined,
    "no token stored for an unknown user"
  );
});

add_task(async function test_set_get_update_clear_roundtrip() {
  lazy.FeltStorage.setLockingToken(EMAIL_A, "ciphertext-1");
  Assert.equal(
    lazy.FeltStorage.getLockingToken(EMAIL_A),
    "ciphertext-1",
    "token is stored"
  );

  lazy.FeltStorage.setLockingToken(EMAIL_A, "ciphertext-2");
  Assert.equal(
    lazy.FeltStorage.getLockingToken(EMAIL_A),
    "ciphertext-2",
    "token is overwritten on a second set"
  );

  lazy.FeltStorage.clearLockingToken(EMAIL_A);
  Assert.equal(
    lazy.FeltStorage.getLockingToken(EMAIL_A),
    undefined,
    "token is removed after clear"
  );
});

add_task(async function test_tokens_are_isolated_per_email() {
  lazy.FeltStorage.setLockingToken(EMAIL_A, "token-a");
  lazy.FeltStorage.setLockingToken(EMAIL_B, "token-b");

  Assert.equal(lazy.FeltStorage.getLockingToken(EMAIL_A), "token-a");
  Assert.equal(lazy.FeltStorage.getLockingToken(EMAIL_B), "token-b");

  lazy.FeltStorage.clearLockingToken(EMAIL_A);
  Assert.equal(
    lazy.FeltStorage.getLockingToken(EMAIL_A),
    undefined,
    "clearing one user does not affect the other"
  );
  Assert.equal(
    lazy.FeltStorage.getLockingToken(EMAIL_B),
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
  lazy.FeltStorage.setLockingToken(EMAIL_A, "persisted-ciphertext");

  // Flush pending writes and reload the backing file from disk.
  await lazy.FeltStorage._feltStorage._save();
  await lazy.FeltStorage.init();

  Assert.equal(
    lazy.FeltStorage.getLockingToken(EMAIL_A),
    "persisted-ciphertext",
    "token survives a save + reload cycle"
  );

  lazy.FeltStorage.clearLockingToken(EMAIL_A);
});
