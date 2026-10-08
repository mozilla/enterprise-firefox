/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

// Tests that the engine enforces "x-compatibility" from policies-schema.json.

const { PolicyFailures } = ChromeUtils.importESModule(
  "resource://gre/modules/PoliciesHelpers.sys.mjs"
);
const { Policies } = ChromeUtils.importESModule(
  "resource:///modules/policies/Policies.sys.mjs"
);

const POLICY_NAME = "CompatTestPolicy";

add_setup(function () {
  Policies[POLICY_NAME] = {};
  registerCleanupFunction(() => {
    delete Policies[POLICY_NAME];
  });
});

function getFailures() {
  return PolicyFailures.getAll()[POLICY_NAME] ?? [];
}

function isCompatPolicyActive() {
  return POLICY_NAME in Services.policies.getActivePolicies();
}

function schemaWithCompatibility(versionAdded) {
  let entry = { type: "boolean" };
  if (versionAdded !== undefined) {
    entry["x-compatibility"] = {
      firefox: { version_added: versionAdded },
      firefox_esr: { version_added: versionAdded },
      firefox_enterprise: { version_added: versionAdded },
    };
  }
  return { type: "object", properties: { [POLICY_NAME]: entry } };
}

add_task(async function test_unsupported_build_is_rejected() {
  // The mock schema below only knows about CompatTestPolicy. Make sure the
  // engine doesn't treat the previous task's run as "policies were applied"
  // and inject onMissing() defaults for real policies (e.g. SitePolicies)
  // that the mock schema would then reject as unknown.
  Services.prefs.clearUserPref("browser.policies.applied");
  await setupPolicyEngineWithJson(
    { policies: { [POLICY_NAME]: true } },
    schemaWithCompatibility(false)
  );

  ok(
    !isCompatPolicyActive(),
    "A policy unsupported by this build is not applied"
  );
  let failures = getFailures();
  equal(failures.length, 1, "One failure was recorded for the policy");
  ok(
    failures[0].includes("is not supported"),
    `The failure explains the rejection: ${failures[0]}`
  );
});

add_task(async function test_supported_version_is_applied() {
  Services.prefs.clearUserPref("browser.policies.applied");
  await setupPolicyEngineWithJson(
    { policies: { [POLICY_NAME]: true } },
    schemaWithCompatibility("149")
  );

  ok(isCompatPolicyActive(), "A policy supported by this build is applied");
  deepEqual(
    PolicyFailures.getAll(),
    {},
    "No failure is reported for a compatible policy"
  );
});

add_task(async function test_metadata_defaults_are_applied() {
  Services.prefs.clearUserPref("browser.policies.applied");
  await setupPolicyEngineWithJson(
    { policies: { [POLICY_NAME]: true } },
    schemaWithCompatibility(undefined)
  );

  ok(
    isCompatPolicyActive(),
    "A policy whose test schema omits metadata gets the injected defaults"
  );
  deepEqual(
    PolicyFailures.getAll(),
    {},
    "No failure is reported when metadata defaults are injected"
  );
});
