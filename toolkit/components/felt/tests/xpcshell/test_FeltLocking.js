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
const { OSKeyStore } = ChromeUtils.importESModule(
  "resource://gre/modules/OSKeyStore.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

// Imported lazily so FeltStorage doesn't resolve its "UAppData"-based path
// before makeFakeAppDir() runs in the head.js add_setup().
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FeltStorage: "resource://gre/modules/enterprise/FeltStorage.sys.mjs",
});

const EMAIL = "user@example.com";

add_setup(async function () {
  do_get_profile();
  await lazy.FeltStorage.init();
  lazy.FeltStorage.updateLastSignedInUserEmail(EMAIL);

  registerCleanupFunction(() => {
    lazy.FeltStorage.clearLockingToken(EMAIL);
  });
});

add_task(async function test_store_encrypts_and_persists() {
  lazy.FeltStorage.updateLastSignedInUserEmail(EMAIL);
  const encrypt = sinon
    .stub(OSKeyStore, "encrypt")
    .resolves("encrypted(refresh-token)");
  const decrypt = sinon
    .stub(OSKeyStore, "decrypt")
    .resolves("refresh-token");
  try {
    await FeltLocking.store("refresh-token");
    Assert.ok(
      encrypt.calledOnceWithExactly("refresh-token"),
      "encrypts the plaintext refresh token"
    );
    Assert.equal(
      await lazy.FeltStorage.getLockingToken(EMAIL),
      "refresh-token",
      "the token persisted for the current user round-trips"
    );
  } finally {
    encrypt.restore();
    decrypt.restore();
    lazy.FeltStorage.clearLockingToken(EMAIL);
  }
});

add_task(async function test_store_throws_when_no_user_known() {
  lazy.FeltStorage.updateLastSignedInUserEmail(undefined);
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
    lazy.FeltStorage.updateLastSignedInUserEmail(EMAIL);
  }
});

add_task(async function test_update_stored_token_updates_existing_token() {
  lazy.FeltStorage.updateLastSignedInUserEmail(EMAIL);
  const encrypt = sinon
    .stub(OSKeyStore, "encrypt")
    .callsFake(async plaintext => `encrypted(${plaintext})`);
  const decrypt = sinon
    .stub(OSKeyStore, "decrypt")
    .callsFake(async ciphertext =>
      ciphertext.replace(/^encrypted\((.*)\)$/, "$1")
    );
  try {
    await lazy.FeltStorage.setLockingToken(EMAIL, "old-token");
    encrypt.resetHistory();

    await FeltLocking.updateStoredToken("rotated-token");
    Assert.ok(
      encrypt.calledOnceWithExactly("rotated-token"),
      "encrypts the rotated refresh token"
    );
    Assert.equal(
      await lazy.FeltStorage.getLockingToken(EMAIL),
      "rotated-token",
      "an already-persisted token is kept in sync"
    );
  } finally {
    encrypt.restore();
    decrypt.restore();
    lazy.FeltStorage.clearLockingToken(EMAIL);
  }
});

add_task(
  async function test_update_stored_token_is_noop_without_existing_token() {
    // Must never create a token: persistence is authorized only by an explicit
    // lock, so a refresh cannot turn a non-locking session lockable.
    lazy.FeltStorage.updateLastSignedInUserEmail(EMAIL);
    lazy.FeltStorage.clearLockingToken(EMAIL);
    const encrypt = sinon.stub(OSKeyStore, "encrypt");
    try {
      await FeltLocking.updateStoredToken("rotated-token");
      Assert.ok(encrypt.notCalled, "does not encrypt when no token is stored");
      Assert.ok(
        !lazy.FeltStorage.hasLockingToken(EMAIL),
        "nothing is persisted when no token already exists"
      );
    } finally {
      encrypt.restore();
    }
  }
);

add_task(async function test_clear_removes_stored_token() {
  lazy.FeltStorage.updateLastSignedInUserEmail(EMAIL);
  const encrypt = sinon.stub(OSKeyStore, "encrypt").resolves("ciphertext");
  try {
    await lazy.FeltStorage.setLockingToken(EMAIL, "token");

    await FeltLocking.clear();

    Assert.ok(
      !lazy.FeltStorage.hasLockingToken(EMAIL),
      "clear removes the stored token"
    );
  } finally {
    encrypt.restore();
  }
});
