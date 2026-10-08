/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Regression test for Bug 2071381, Firefox Enterprise console
// path. A null-valued LOCAL policy must not disable enforcement of policies
// that were successfully fetched from the console.
//
// Before the fix, the merged null value made isEmptyObject() throw in
// _updateStatus() after the successful remote fetch; because _updateStatus()
// ran outside _initialize()'s try/catch, the exception aborted initialization
// and the successfully fetched console policies were silently dropped, leaving
// the engine UNINITIALIZED (fail-open). After the fix the null value is ignored
// and the console policy still applies.

const { FileTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/FileTestUtils.sys.mjs"
);

const NULL_LOCAL_POLICIES = { policies: { x: null } };
const REMOTE_CONSOLE_POLICIES = {
  policies: {
    SecurityLogging: { Download: { Enabled: true } },
  },
};

const policiesSvc = Services.policies;
const policiesObs = policiesSvc.QueryInterface(Ci.nsIObserver);

registerCleanupFunction(() => {
  Services.prefs.clearUserPref("browser.policies.alternatePath");
});

add_task(async function test_null_local_policy_preserves_console_policies() {
  const filePath = FileTestUtils.getTempFile("policies.json").path;
  await IOUtils.writeJSON(filePath, NULL_LOCAL_POLICIES);
  Services.prefs.setStringPref("browser.policies.alternatePath", filePath);
  EnterprisePolicyTesting.stubRemotePolicies(REMOTE_CONSOLE_POLICIES);

  Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
  let threw = null;
  try {
    policiesObs.observe(null, "policies-startup", null);
  } catch (e) {
    threw = e;
  }

  Assert.equal(
    threw,
    null,
    "The null-valued local policy no longer aborts initialization"
  );
  Assert.equal(
    policiesSvc.status,
    Ci.nsIEnterprisePolicies.ACTIVE,
    "The engine is ACTIVE"
  );

  const active = policiesSvc.getActivePolicies();
  Assert.ok(
    "SecurityLogging" in active,
    "The successfully fetched console policy is still applied"
  );
  Assert.ok(
    !("x" in active),
    "The null-valued local policy is ignored, not applied"
  );
});
