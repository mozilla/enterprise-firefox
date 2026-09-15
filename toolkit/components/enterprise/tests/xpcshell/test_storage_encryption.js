/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Basic test coverage for EnterpriseStorageEncryption.load (the
// enterprise-managed primary password). The console endpoint is
// stubbed via ConsoleClient.getPrimarySecret so we can drive load()'s success
// path and every failure path.

const { EnterpriseStorageEncryption } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/EnterpriseStorageEncryption.sys.mjs"
);
const { ConsoleClient } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/ConsoleClient.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const SECRET = "console-managed-primary-secret";
const UNLOCK_FAILED = Ci.nsIFelt.FeltEncryptionExitCode_SdrTokenUnlockFailed;

do_get_profile();

function getToken() {
  return Cc["@mozilla.org/security/internalkeytoken;1"].createInstance(
    Ci.nsIPKCS11Token
  );
}

async function clearTokenPassword(current) {
  const token = getToken();
  if (token.hasPassword) {
    await token.changePassword(current, "");
  }
  await token.logout();
}

// Services.startup.quit is a non-configurable XPCOM method, so sinon can't wrap
// it. Reading Services.startup first resolves the lazy service getter into a
// writable data property; then we can swap in a fake whose quit() records its
// arguments.
function stubStartupQuit() {
  const real = Services.startup;
  const calls = [];
  Services.startup = {
    quit(mode, exitCode) {
      calls.push({ mode, exitCode });
    },
  };
  return {
    calls,
    restore() {
      Services.startup = real;
    },
  };
}

add_task(async function test_load_sets_and_unlocks_on_fresh_token() {
  const sandbox = sinon.createSandbox();
  sandbox.stub(ConsoleClient, "getPrimarySecret").resolves({ data: SECRET });
  const startup = stubStartupQuit();
  try {
    await EnterpriseStorageEncryption.load();

    const token = getToken();
    Assert.ok(token.hasPassword, "primary password set on the fresh token");
    Assert.ok(token.isLoggedIn, "token unlocked after load()");
    Assert.equal(startup.calls.length, 0, "did not force-quit on success");
  } finally {
    await clearTokenPassword(SECRET);
    startup.restore();
    sandbox.restore();
  }
});

add_task(async function test_load_unlocks_when_password_already_set() {
  // Token already carries the console secret: load() must skip changePassword
  // and still log in.
  const setup = getToken();
  await setup.changePassword("", SECRET);
  await setup.logout();

  const sandbox = sinon.createSandbox();
  sandbox.stub(ConsoleClient, "getPrimarySecret").resolves({ data: SECRET });
  const startup = stubStartupQuit();
  try {
    await EnterpriseStorageEncryption.load();

    const token = getToken();
    Assert.ok(token.hasPassword, "password remains set");
    Assert.ok(token.isLoggedIn, "token unlocked with the existing password");
    Assert.equal(startup.calls.length, 0, "did not force-quit on success");
  } finally {
    await clearTokenPassword(SECRET);
    startup.restore();
    sandbox.restore();
  }
});

add_task(async function test_load_force_quits_when_secret_fetch_fails() {
  const sandbox = sinon.createSandbox();
  sandbox
    .stub(ConsoleClient, "getPrimarySecret")
    .rejects(new Error("console unreachable"));
  const startup = stubStartupQuit();
  try {
    await EnterpriseStorageEncryption.load();

    Assert.equal(startup.calls.length, 1, "force-quit once");
    Assert.equal(startup.calls[0].mode, Ci.nsIAppStartup.eForceQuit);
    Assert.equal(
      startup.calls[0].exitCode,
      UNLOCK_FAILED,
      "SdrTokenUnlockFailed exit code when the secret fetch throws"
    );
    Assert.ok(!getToken().hasPassword, "token untouched on failure");
  } finally {
    await clearTokenPassword("");
    startup.restore();
    sandbox.restore();
  }
});

add_task(async function test_load_force_quits_when_secret_missing() {
  const sandbox = sinon.createSandbox();
  sandbox.stub(ConsoleClient, "getPrimarySecret").resolves({});
  const startup = stubStartupQuit();
  try {
    await EnterpriseStorageEncryption.load();

    Assert.equal(startup.calls.length, 1, "force-quit once");
    Assert.equal(startup.calls[0].mode, Ci.nsIAppStartup.eForceQuit);
    Assert.equal(
      startup.calls[0].exitCode,
      UNLOCK_FAILED,
      "SdrTokenUnlockFailed exit code when the payload has no secret"
    );
  } finally {
    await clearTokenPassword("");
    startup.restore();
    sandbox.restore();
  }
});

add_task(async function test_load_force_quits_when_secret_empty() {
  const sandbox = sinon.createSandbox();
  sandbox.stub(ConsoleClient, "getPrimarySecret").resolves({ data: "" });
  const startup = stubStartupQuit();
  try {
    await EnterpriseStorageEncryption.load();

    Assert.equal(startup.calls.length, 1, "force-quit once");
    Assert.equal(startup.calls[0].mode, Ci.nsIAppStartup.eForceQuit);
    Assert.equal(
      startup.calls[0].exitCode,
      UNLOCK_FAILED,
      "SdrTokenUnlockFailed exit code when the secret is empty"
    );
    Assert.ok(!getToken().hasPassword, "token untouched on failure");
  } finally {
    await clearTokenPassword("");
    startup.restore();
    sandbox.restore();
  }
});

add_task(async function test_load_force_quits_when_login_fails() {
  // Token already has a different password, so changePassword is skipped and
  // the login with the console secret fails.
  const setup = getToken();
  await setup.changePassword("", "some-other-password");
  await setup.logout();

  const sandbox = sinon.createSandbox();
  sandbox.stub(ConsoleClient, "getPrimarySecret").resolves({ data: SECRET });
  const startup = stubStartupQuit();
  try {
    await EnterpriseStorageEncryption.load();

    Assert.equal(startup.calls.length, 1, "force-quit once");
    Assert.equal(startup.calls[0].mode, Ci.nsIAppStartup.eForceQuit);
    Assert.equal(
      startup.calls[0].exitCode,
      UNLOCK_FAILED,
      "SdrTokenUnlockFailed exit code when the token does not unlock"
    );
  } finally {
    await clearTokenPassword("some-other-password");
    startup.restore();
    sandbox.restore();
  }
});
