/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Regression test for Bug 2071381: a null-valued policy in a
// local policies.json must be ignored, not crash policy initialization.
//
// Before the fix, isEmptyObject() evaluated Object.keys(null) (since
// `typeof null == "object"`) and threw, aborting _initialize() and leaving the
// engine UNINITIALIZED. This is the console-free (upstream-shared) case: the
// null value must be skipped as an unknown policy while a valid sibling policy
// still applies.
//
// The startup is driven through the "policies-startup" observer directly rather
// than EnterprisePolicies:Restart, whose idle-dispatched driver would have
// swallowed the pre-fix exception and hung instead of surfacing it.

const { FileTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/FileTestUtils.sys.mjs"
);

const policiesSvc = Services.policies;
const policiesObs = policiesSvc.QueryInterface(Ci.nsIObserver);

async function startupWithLocalPolicies(json) {
  const filePath = FileTestUtils.getTempFile("policies.json").path;
  await IOUtils.writeJSON(filePath, json);
  Services.prefs.setStringPref("browser.policies.alternatePath", filePath);

  Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
  let threw = null;
  try {
    policiesObs.observe(null, "policies-startup", null);
  } catch (e) {
    threw = e;
  }
  return threw;
}

registerCleanupFunction(() => {
  Services.prefs.clearUserPref("browser.policies.alternatePath");
  Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
});

add_task(async function test_null_local_policy_ignored_valid_sibling_applies() {
  const threw = await startupWithLocalPolicies({
    policies: { x: null, BlockAboutConfig: true },
  });

  Assert.equal(threw, null, "A null-valued policy no longer crashes init");
  Assert.equal(
    policiesSvc.status,
    Ci.nsIEnterprisePolicies.ACTIVE,
    "The engine is ACTIVE"
  );

  const active = policiesSvc.getActivePolicies();
  Assert.ok(
    "BlockAboutConfig" in active,
    "The valid sibling policy is applied despite the null-valued policy"
  );
  Assert.ok(
    !("x" in active),
    "The null-valued (unknown) policy is skipped, not applied"
  );
});
