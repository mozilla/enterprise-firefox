/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Regression test for Bug 2071381, init-failure handling.
//
// When policy initialization hits an unexpected error after a successful remote
// fetch, a managed (felt) browser must fail closed (initiateShutdown) rather
// than run unmanaged, while a consumer (non-felt) browser must not shut down.
// Either way the engine must discard the partial state (status FAILED, no
// partial policy set) rather than advertise ACTIVE. This guards the whole
// post-fetch init path, not just the specific null-policy crash the
// isEmptyObject fix already handles.
//
// The error is induced by forcing _updateStatus() to throw; Services.felt is
// faked to control isFeltBrowser() and to capture any shutdown without actually
// signing the session out.

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const REMOTE_CONSOLE_POLICIES = {
  policies: { SecurityLogging: { Download: { Enabled: true } } },
};

const policiesSvc = Services.policies;
const policiesObs = policiesSvc.QueryInterface(Ci.nsIObserver);

function withFakeFelt(isFeltBrowser, fn) {
  const realFelt = Services.felt;
  let signoutCalled = false;
  Object.defineProperty(Services, "felt", {
    configurable: true,
    value: {
      isFeltBrowser: () => isFeltBrowser,
      performSignout: () => {
        signoutCalled = true;
      },
    },
  });
  try {
    return fn(() => signoutCalled);
  } finally {
    Object.defineProperty(Services, "felt", {
      configurable: true,
      value: realFelt,
    });
  }
}

// Drive a fresh startup whose _updateStatus() throws an unexpected (non
// remote-fetch) error, and return whether observe() propagated it.
function driveStartupWithInducedFailure() {
  const mgr = policiesSvc.wrappedJSObject;
  const stub = sinon
    .stub(mgr, "_updateStatus")
    .throws(new Error("induced init failure"));
  try {
    Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
    let threw = null;
    try {
      policiesObs.observe(null, "policies-startup", null);
    } catch (e) {
      threw = e;
    }
    return threw;
  } finally {
    stub.restore();
  }
}

function assertFailedAndEmpty() {
  Assert.equal(
    policiesSvc.status,
    Ci.nsIEnterprisePolicies.FAILED,
    "The engine is left FAILED, not ACTIVE"
  );
  Assert.deepEqual(
    policiesSvc.getActivePolicies(),
    {},
    "No policies are left applied after a failed init"
  );
}

registerCleanupFunction(() => {
  Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
});

add_task(async function test_managed_init_failure_fails_closed() {
  EnterprisePolicyTesting.stubRemotePolicies(REMOTE_CONSOLE_POLICIES);

  withFakeFelt(true, signoutCalled => {
    const threw = driveStartupWithInducedFailure();

    Assert.equal(
      threw,
      null,
      "The unexpected init error is caught, not propagated to the caller"
    );
    Assert.ok(
      signoutCalled(),
      "A managed (felt) browser fails closed via initiateShutdown()"
    );
    assertFailedAndEmpty();
  });
});

add_task(async function test_consumer_init_failure_does_not_shut_down() {
  EnterprisePolicyTesting.stubRemotePolicies(REMOTE_CONSOLE_POLICIES);

  withFakeFelt(false, signoutCalled => {
    const threw = driveStartupWithInducedFailure();

    Assert.equal(
      threw,
      null,
      "The unexpected init error is caught, not propagated to the caller"
    );
    Assert.ok(
      !signoutCalled(),
      "A consumer (non-felt) browser does not shut down on an init failure"
    );
    assertFailedAndEmpty();
  });
});
