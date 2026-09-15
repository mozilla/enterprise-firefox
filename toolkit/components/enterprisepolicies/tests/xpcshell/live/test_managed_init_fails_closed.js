/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Regression test for Bug 2071381, init-failure handling.
//
// When policy initialization hits an unexpected error after a successful remote
// fetch, a managed (felt) browser must fail closed (initiateShutdown) rather
// than run unmanaged, while a browser that is not felt managed must not shut
// down. Either way the engine must discard the partial state (status FAILED,
// no partial policy set, no provider for a later policy update to re-apply)
// rather than advertise ACTIVE, while keeping the cleanup scheduled for the
// previous session's policies. This guards the whole post-fetch init path, not
// just the specific null-policy crash the isEmptyObject fix already handles.
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

function assertFailedAndEmpty(when) {
  Assert.equal(
    policiesSvc.status,
    Ci.nsIEnterprisePolicies.FAILED,
    `The engine is FAILED, not ACTIVE, ${when}`
  );
  Assert.deepEqual(
    policiesSvc.getActivePolicies(),
    {},
    `No policies are applied ${when}`
  );
}

// The remote polling started by EnterprisePolicies:Initialized fires an update
// when it sees changed policies. With the fetched policies still held by the
// provider, that update would re-apply them and put the engine back to ACTIVE.
function assertUpdateDoesNotReactivate() {
  assertFailedAndEmpty("after the failed init");
  Services.obs.notifyObservers(null, "EnterprisePolicies:Update");
  assertFailedAndEmpty("after a policy update following the failed init");
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
    assertUpdateDoesNotReactivate();
  });
});

add_task(async function test_non_felt_init_failure_does_not_shut_down() {
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
      "A browser that is not felt managed does not shut down on an init failure"
    );
    assertUpdateDoesNotReactivate();
  });
});

// _initialize() schedules the cleanup for the previous session's policies and
// clears browser.policies.applied before building the provider. Discarding the
// failed init's partial state must not drop that cleanup along with it, or it
// would never run.
add_task(async function test_init_failure_keeps_previous_session_cleanup() {
  EnterprisePolicyTesting.stubRemotePolicies(REMOTE_CONSOLE_POLICIES);
  Services.prefs.setBoolPref("browser.policies.applied", true);

  const cleanupTimings = [];
  const cleanupObserver = (subject, topic, data) => cleanupTimings.push(data);
  Services.obs.addObserver(cleanupObserver, "EnterprisePolicies:Cleanup");
  try {
    withFakeFelt(false, () => {
      driveStartupWithInducedFailure();
    });
  } finally {
    Services.obs.removeObserver(cleanupObserver, "EnterprisePolicies:Cleanup");
  }

  Assert.deepEqual(
    cleanupTimings,
    ["onBeforeAddons"],
    "The previous session's cleanup still runs after a failed init"
  );
  Assert.ok(
    !Services.prefs.getBoolPref("browser.policies.applied", false),
    "The applied-policies pref stays cleared after a failed init"
  );
  assertFailedAndEmpty("after the failed init");
});
