/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tests for the FeltLocking store/updateStoredToken/clear surface, and for the
// posture handling of tryUnlock with its FELT dependencies (Services.felt,
// OSKeyStore, ConsoleClient, DevicePosture, and the FeltProcess actor)
// stubbed.

const { FeltLocking } = ChromeUtils.importESModule(
  "chrome://felt/content/FeltLocking.sys.mjs"
);
const { DevicePosture } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/DevicePosture.sys.mjs"
);
const { OSKeyStore } = ChromeUtils.importESModule(
  "resource://gre/modules/OSKeyStore.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
const { ConsoleClient } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/ConsoleClient.sys.mjs"
);

// Imported lazily so FeltStorage doesn't resolve its "UAppData"-based path
// before makeFakeAppDir() runs in the head.js add_setup().
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FeltStorage: "resource://gre/modules/enterprise/FeltStorage.sys.mjs",
});

const EMAIL = "user@example.com";
let gProfilePath;

add_setup(async function () {
  gProfilePath = do_get_profile().path;
  await lazy.FeltStorage.init();
  lazy.FeltStorage.updateLastSignedInUserEmail(EMAIL);

  // With this pref set, resolveManagedProfile returns the path directly
  // instead of get-or-creating a managed profile via the profile service.
  Services.prefs.setStringPref("enterprise.profile_path", gProfilePath);

  // tryUnlock formats OS-auth dialog strings from the enterprise FTL, which the
  // xpcshell runner does not register; supply them from an in-memory source.
  const mockSource = L10nFileSource.createMock(
    "felt-mock",
    "app",
    ["en-US"],
    "/felt-mock/{locale}/",
    [
      {
        path: "/felt-mock/en-US/toolkit/enterprise/felt.ftl",
        source:
          "felt-sso-unlock-os-auth-dialog-message = message\n" +
          "felt-sso-unlock-os-auth-dialog-caption = caption\n",
      },
      // The Localization instance also loads brand.ftl, and a bundle with any
      // missing resource fails to generate at all.
      {
        path: "/felt-mock/en-US/branding/brand.ftl",
        source: "-brand-short-name = Firefox Enterprise\n",
      },
    ]
  );
  L10nRegistry.getInstance().registerSources([mockSource]);

  registerCleanupFunction(() => {
    lazy.FeltStorage.clearLockingToken(EMAIL);
  });
});

add_task(async function test_store_encrypts_and_persists() {
  lazy.FeltStorage.updateLastSignedInUserEmail(EMAIL);
  const encrypt = sinon
    .stub(OSKeyStore, "encrypt")
    .resolves("encrypted(refresh-token)");
  const decrypt = sinon.stub(OSKeyStore, "decrypt").resolves("refresh-token");
  try {
    await FeltLocking.store("refresh-token", "user-123");
    Assert.ok(
      encrypt.calledOnceWithExactly("refresh-token"),
      "encrypts the plaintext refresh token"
    );
    Assert.equal(
      lazy.FeltStorage.getLockingUserId(EMAIL),
      "user-123",
      "the user id is persisted alongside the token"
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
      FeltLocking.store("refresh-token", "user-123"),
      /no signed-in user/,
      "rejects so the caller can fall back to signing out"
    );
    Assert.ok(encrypt.notCalled, "does not encrypt when no user is known");
  } finally {
    encrypt.restore();
    lazy.FeltStorage.updateLastSignedInUserEmail(EMAIL);
  }
});

add_task(async function test_store_throws_when_token_or_user_id_missing() {
  // An empty token offers an unlock that can never succeed; a missing user id
  // would resume into the profile shared by every user.
  lazy.FeltStorage.updateLastSignedInUserEmail(EMAIL);
  const encrypt = sinon.stub(OSKeyStore, "encrypt");
  try {
    await Assert.rejects(
      FeltLocking.store("", "user-123"),
      /missing refresh token or user id/,
      "rejects on an empty refresh token"
    );
    await Assert.rejects(
      FeltLocking.store("refresh-token", undefined),
      /missing refresh token or user id/,
      "rejects on a missing user id"
    );
    Assert.ok(encrypt.notCalled, "does not encrypt when validation fails");
    Assert.ok(
      !lazy.FeltStorage.hasLockingToken(EMAIL),
      "nothing is persisted when validation fails"
    );
  } finally {
    encrypt.restore();
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

/**
 * Services.felt is only registered on a running FELT instance, so the xpcshell
 * runner needs a fake installed via defineProperty (plain sinon.stub requires
 * the property to be present).
 *
 * @returns {object} A disposable exposing the setTokens spy.
 */
/* eslint-disable mozilla/valid-services */
function installFakeFelt() {
  const had = Object.prototype.hasOwnProperty.call(Services, "felt");
  const prev = had ? Services.felt : undefined;
  const setTokens = sinon.spy();
  Object.defineProperty(Services, "felt", {
    value: { setTokens },
    configurable: true,
    writable: true,
  });
  return {
    setTokens,
    [Symbol.dispose]() {
      if (had) {
        Services.felt = prev;
      } else {
        delete Services.felt;
      }
    },
  };
}
/* eslint-enable mozilla/valid-services */

// A browser whose FeltProcess parent actor records the messages it receives.
function makeFakeBrowser(messages) {
  return {
    browsingContext: {
      currentWindowGlobal: {
        domProcess: {
          getActor: () => ({
            async receiveMessage(message) {
              messages.push(message);
            },
          }),
        },
      },
    },
  };
}

function setupUnlockStubs({ refreshTokens }) {
  return [
    sinon
      .stub(OSKeyStore, "encrypt")
      .callsFake(async plaintext => `encrypted(${plaintext})`),
    sinon
      .stub(OSKeyStore, "decrypt")
      .callsFake(async ciphertext =>
        String(ciphertext).replace(/^encrypted\((.*)\)$/, "$1")
      ),
    sinon.stub(OSKeyStore, "ensureLoggedIn").resolves({ authenticated: true }),
    sinon.stub(ConsoleClient, "refreshTokens").resolves(refreshTokens),
    sinon.stub(DevicePosture, "collect"),
  ];
}

add_task(async function test_try_unlock_submits_posture_with_refresh() {
  lazy.FeltStorage.updateLastSignedInUserEmail(EMAIL);
  // eslint-disable-next-line no-unused-vars
  using _felt = installFakeFelt();

  const POSTURE = { os: { name: "test-os" } };
  const stubs = setupUnlockStubs({
    refreshTokens: {
      access_token: "access",
      refresh_token: "rotated",
      expires_at: 4102444800,
      postureSubmitted: true,
    },
  });
  DevicePosture.collect.resolves(POSTURE);
  const messages = [];
  try {
    await lazy.FeltStorage.setLockingToken(EMAIL, "stored-token", "user-123");

    const unlocked = await FeltLocking.tryUnlock(
      EMAIL,
      makeFakeBrowser(messages)
    );

    Assert.ok(unlocked, "the session unlocks");
    Assert.ok(
      DevicePosture.collect.calledOnceWith({ profileDir: gProfilePath }),
      "posture is collected from the resumed user's profile"
    );
    Assert.deepEqual(
      ConsoleClient.refreshTokens.firstCall.args[0],
      { posture: POSTURE },
      "the resuming refresh submits the measured posture"
    );
    Assert.equal(messages.length, 1, "Firefox is started once");
    const { data } = messages[0];
    Assert.equal(
      data.measuredPosture,
      POSTURE,
      "the submitted posture is forwarded so it can become the monitor baseline"
    );
    Assert.ok(data.postureSubmitted, "the refresh reported the submission");
    Assert.equal(data.user_id, "user-123", "the stored user id is forwarded");
    Assert.equal(
      await lazy.FeltStorage.getLockingToken(EMAIL),
      "rotated",
      "the rotated refresh token is persisted"
    );
  } finally {
    stubs.forEach(stub => stub.restore());
    lazy.FeltStorage.clearLockingToken(EMAIL);
  }
});

add_task(async function test_try_unlock_fails_when_posture_collect_fails() {
  // Posture gates the unlock the way it gates a login: a failed collect must
  // fall back to sign-in without contacting the console, keeping the stored
  // token so a later unlock can still succeed.
  lazy.FeltStorage.updateLastSignedInUserEmail(EMAIL);
  // eslint-disable-next-line no-unused-vars
  using _felt = installFakeFelt();

  const stubs = setupUnlockStubs({
    refreshTokens: {
      access_token: "access",
      refresh_token: "rotated",
      expires_at: 4102444800,
      postureSubmitted: true,
    },
  });
  DevicePosture.collect.rejects(new Error("posture probe failed"));
  const messages = [];
  try {
    await lazy.FeltStorage.setLockingToken(EMAIL, "stored-token", "user-123");

    const unlocked = await FeltLocking.tryUnlock(
      EMAIL,
      makeFakeBrowser(messages)
    );

    Assert.ok(!unlocked, "the unlock fails");
    Assert.ok(
      ConsoleClient.refreshTokens.notCalled,
      "no refresh is attempted without a posture"
    );
    Assert.equal(messages.length, 0, "Firefox is not started");
    Assert.equal(
      await lazy.FeltStorage.getLockingToken(EMAIL),
      "stored-token",
      "the stored token is kept for a later unlock"
    );
  } finally {
    stubs.forEach(stub => stub.restore());
    lazy.FeltStorage.clearLockingToken(EMAIL);
  }
});

add_task(async function test_try_unlock_clears_record_when_persist_fails() {
  // The resuming refresh spends the stored token, so when the rotated one
  // cannot be persisted the record is dropped (it could only offer a doomed
  // unlock) while the resumed session itself lives on.
  lazy.FeltStorage.updateLastSignedInUserEmail(EMAIL);
  // eslint-disable-next-line no-unused-vars
  using _felt = installFakeFelt();

  const stubs = setupUnlockStubs({
    refreshTokens: {
      access_token: "access",
      refresh_token: "rotated",
      expires_at: 4102444800,
      postureSubmitted: true,
    },
  });
  // First call encrypts the setup write below; the second is the rotated-token
  // persist inside tryUnlock.
  stubs[0].onSecondCall().rejects(new Error("keystore write failed"));
  DevicePosture.collect.resolves({ os: { name: "test-os" } });
  const messages = [];
  try {
    await lazy.FeltStorage.setLockingToken(EMAIL, "stored-token", "user-123");

    const unlocked = await FeltLocking.tryUnlock(
      EMAIL,
      makeFakeBrowser(messages)
    );

    Assert.ok(unlocked, "the session still unlocks");
    Assert.equal(messages.length, 1, "Firefox is started once");
    Assert.ok(
      !lazy.FeltStorage.hasLockingToken(EMAIL),
      "the record holding the spent token is dropped"
    );
  } finally {
    stubs.forEach(stub => stub.restore());
    lazy.FeltStorage.clearLockingToken(EMAIL);
  }
});

add_task(async function test_try_unlock_fails_without_stored_user_id() {
  // A record without a user id would resume into the profile shared by every
  // user, so it is dropped and the unlock falls back to sign-in.
  lazy.FeltStorage.updateLastSignedInUserEmail(EMAIL);
  // eslint-disable-next-line no-unused-vars
  using _felt = installFakeFelt();

  const stubs = setupUnlockStubs({
    refreshTokens: {
      access_token: "access",
      refresh_token: "rotated",
      expires_at: 4102444800,
      postureSubmitted: true,
    },
  });
  DevicePosture.collect.resolves({ os: { name: "test-os" } });
  const messages = [];
  try {
    await lazy.FeltStorage.setLockingToken(EMAIL, "stored-token");

    const unlocked = await FeltLocking.tryUnlock(
      EMAIL,
      makeFakeBrowser(messages)
    );

    Assert.ok(!unlocked, "the unlock fails");
    Assert.ok(DevicePosture.collect.notCalled, "no posture is collected");
    Assert.ok(ConsoleClient.refreshTokens.notCalled, "no refresh is attempted");
    Assert.equal(messages.length, 0, "Firefox is not started");
    Assert.ok(
      !lazy.FeltStorage.hasLockingToken(EMAIL),
      "the unresumeable record is dropped"
    );
  } finally {
    stubs.forEach(stub => stub.restore());
    lazy.FeltStorage.clearLockingToken(EMAIL);
  }
});
