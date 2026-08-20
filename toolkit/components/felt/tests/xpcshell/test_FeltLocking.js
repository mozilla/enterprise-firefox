/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tests for the FeltLocking store/updateStoredToken/clear surface. tryUnlock is not
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

const EMAIL = "user@example.com";

add_setup(async function () {
  do_get_profile();
  await FeltStorage.init();
  FeltStorage.updateLastSignedInUserEmail(EMAIL);

  registerCleanupFunction(() => {
    FeltStorage.clearLockingToken(EMAIL);
  });
});

add_task(async function test_store_encrypts_and_persists() {
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

add_task(async function test_update_stored_token_updates_existing_token() {
  FeltStorage.updateLastSignedInUserEmail(EMAIL);
  FeltStorage.setLockingToken(EMAIL, "old-ciphertext");
  const encrypt = sinon
    .stub(OSKeyStore, "encrypt")
    .resolves("encrypted(rotated-token)");
  try {
    await FeltLocking.updateStoredToken("rotated-token");
    Assert.ok(
      encrypt.calledOnceWithExactly("rotated-token"),
      "encrypts the rotated refresh token"
    );
    Assert.equal(
      FeltStorage.getLockingToken(EMAIL),
      "encrypted(rotated-token)",
      "an already-persisted token is kept in sync"
    );
  } finally {
    encrypt.restore();
    FeltStorage.clearLockingToken(EMAIL);
  }
});

add_task(
  async function test_update_stored_token_is_noop_without_existing_token() {
    // Must never create a token: persistence is authorized only by an explicit
    // lock, so a refresh cannot turn a non-locking session lockable.
    FeltStorage.updateLastSignedInUserEmail(EMAIL);
    FeltStorage.clearLockingToken(EMAIL);
    const encrypt = sinon.stub(OSKeyStore, "encrypt");
    try {
      await FeltLocking.updateStoredToken("rotated-token");
      Assert.ok(encrypt.notCalled, "does not encrypt when no token is stored");
      Assert.equal(
        FeltStorage.getLockingToken(EMAIL),
        undefined,
        "nothing is persisted when no token already exists"
      );
    } finally {
      encrypt.restore();
    }
  }
);

add_task(async function test_clear_removes_stored_token() {
  FeltStorage.updateLastSignedInUserEmail(EMAIL);
  FeltStorage.setLockingToken(EMAIL, "ciphertext");

  await FeltLocking.clear();

  Assert.equal(
    FeltStorage.getLockingToken(EMAIL),
    undefined,
    "clear removes the stored token"
  );
});
