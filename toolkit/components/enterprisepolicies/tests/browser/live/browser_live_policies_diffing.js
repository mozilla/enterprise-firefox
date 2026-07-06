/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const customSchema = {
  properties: {
    TestPolicy: {
      type: "string",
    },
  },
};

let currentPolicyValue = POLICY_PARAM_STATE.DEFAULT;

const TestPolicy = {
  onBeforeUIStartup(manager, param) {
    currentPolicyValue = param;
  },
  onRemove(_manager, _oldParam) {
    currentPolicyValue = POLICY_PARAM_STATE.REMOVED;
  },
};

add_setup(async () => {
  Policies.TestPolicy = TestPolicy;

  registerCleanupFunction(async () => {
    delete Policies.TestPolicy;
  });
});

add_task(async function test_policy_update_apply_new_policy() {
  currentPolicyValue = POLICY_PARAM_STATE.DEFAULT;

  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {},
    },
    customSchema
  );

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    {},
    "Expected no policies to be applied."
  );
  Assert.equal(
    currentPolicyValue,
    POLICY_PARAM_STATE.DEFAULT,
    "Expected the default policy parameter."
  );

  const policies = {
    policies: {
      TestPolicy: POLICY_PARAM_STATE.APPLIED,
    },
  };

  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies(policies);
  await updateApplied;

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    { TestPolicy: POLICY_PARAM_STATE.APPLIED },
    "Expected remote policy TestPolicy with parameter APPLIED."
  );
  Assert.equal(
    currentPolicyValue,
    POLICY_PARAM_STATE.APPLIED,
    `Expected the policy parameter "applied".`
  );
});

add_task(async function test_policy_update_apply_policy_param_update() {
  currentPolicyValue = POLICY_PARAM_STATE.DEFAULT;

  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        TestPolicy: POLICY_PARAM_STATE.APPLIED,
      },
    },
    customSchema
  );

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    { TestPolicy: POLICY_PARAM_STATE.APPLIED },
    "Expected remote policy TestPolicy with parameter APPLIED."
  );
  Assert.equal(
    currentPolicyValue,
    POLICY_PARAM_STATE.APPLIED,
    `Expected the policy parameter "applied".`
  );

  currentPolicyValue = POLICY_PARAM_STATE.DEFAULT;

  const policies = {
    policies: {
      TestPolicy: POLICY_PARAM_STATE.UPDATED_BY_REMOTE_POLICY,
    },
  };

  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies(policies);
  await updateApplied;

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    { TestPolicy: POLICY_PARAM_STATE.UPDATED_BY_REMOTE_POLICY },
    "Expected remote policy TestPolicy with parameter UPDATED."
  );
  Assert.equal(
    currentPolicyValue,
    POLICY_PARAM_STATE.UPDATED_BY_REMOTE_POLICY,
    `Expected the policy parameter "updated".`
  );
});

add_task(async function test_policy_update_remove_old_policy() {
  currentPolicyValue = POLICY_PARAM_STATE.DEFAULT;

  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        TestPolicy: POLICY_PARAM_STATE.APPLIED,
      },
    },
    customSchema
  );

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    { TestPolicy: POLICY_PARAM_STATE.APPLIED },
    "Expected remote policy TestPolicy with parameter APPLIED."
  );
  Assert.equal(
    currentPolicyValue,
    POLICY_PARAM_STATE.APPLIED,
    `Expected the policy parameter "applied".`
  );

  const policies = {
    policies: {},
  };

  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies(policies);
  await updateApplied;

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    {},
    "Expected remote policy TestPolicy to be removed."
  );
  Assert.equal(
    currentPolicyValue,
    POLICY_PARAM_STATE.REMOVED,
    "Expected the policy parameter to be of state REMOVED."
  );
});

add_task(async function test_policy_update_no_changes() {
  currentPolicyValue = POLICY_PARAM_STATE.DEFAULT;

  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        TestPolicy: POLICY_PARAM_STATE.APPLIED,
      },
    },
    customSchema
  );

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    { TestPolicy: POLICY_PARAM_STATE.APPLIED },
    "Expected remote policy TestPolicy with parameter APPLIED."
  );
  Assert.equal(
    currentPolicyValue,
    POLICY_PARAM_STATE.APPLIED,
    `Expected the policy parameter "applied".`
  );

  // Revert the tracked value locally. A subsequent poll that returns the same
  // remote policies must not re-apply the policy since the payload is
  // unchanged.
  currentPolicyValue = POLICY_PARAM_STATE.DEFAULT;

  let updateDispatched = false;
  const onUpdate = () => {
    updateDispatched = true;
  };
  Services.obs.addObserver(onUpdate, "EnterprisePolicies:PolicyUpdatesApplied");

  // Wait for two more polls. Once the second poll fetches, the first poll's
  // full cycle (fetch and any update dispatch) has completed.
  const pollsBefore = EnterprisePolicyTesting.remotePoliciesStub.callCount;
  await TestUtils.waitForCondition(
    () =>
      EnterprisePolicyTesting.remotePoliciesStub.callCount > pollsBefore + 1,
    "Waiting for the poller to fetch the unchanged remote policies twice"
  );

  Services.obs.removeObserver(
    onUpdate,
    "EnterprisePolicies:PolicyUpdatesApplied"
  );

  Assert.ok(
    !updateDispatched,
    "Expected no policy update to be dispatched for unchanged remote policies."
  );

  // Verify that the policy's callback wasn't called a second time.
  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    { TestPolicy: POLICY_PARAM_STATE.APPLIED },
    "Expected no changes to the active policy specifications."
  );
  Assert.equal(
    currentPolicyValue,
    POLICY_PARAM_STATE.DEFAULT,
    "Expected local changes to policy parameters to not get overridden."
  );

  const policies = {
    policies: {},
  };

  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies(policies);
  await updateApplied;

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    {},
    "Expected remote policy TestPolicy to be removed."
  );
  Assert.equal(
    currentPolicyValue,
    POLICY_PARAM_STATE.REMOVED,
    "Expected the policy parameter to be of state REMOVED."
  );
});

add_task(async function test_policy_update_invalid_params_keeps_previous() {
  currentPolicyValue = POLICY_PARAM_STATE.DEFAULT;

  // Apply the policy with valid parameters.
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        TestPolicy: POLICY_PARAM_STATE.APPLIED,
      },
    },
    customSchema
  );

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    { TestPolicy: POLICY_PARAM_STATE.APPLIED },
    "Expected remote policy TestPolicy with parameter APPLIED."
  );
  Assert.equal(
    currentPolicyValue,
    POLICY_PARAM_STATE.APPLIED,
    `Expected the policy parameter "applied".`
  );

  // Reset so we can detect whether any callback runs on the next update.
  currentPolicyValue = POLICY_PARAM_STATE.DEFAULT;

  // Update the policy with invalid parameters (an object where the schema
  // requires a string). The previously applied policy must be kept, i.e.
  // neither removed nor re-applied.
  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies({
    policies: {
      TestPolicy: { invalid: true },
    },
  });
  await updateApplied;

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    { TestPolicy: POLICY_PARAM_STATE.APPLIED },
    "Expected the previously applied TestPolicy to be kept on invalid params."
  );
  Assert.equal(
    currentPolicyValue,
    POLICY_PARAM_STATE.DEFAULT,
    "Expected the policy to be neither removed nor re-applied."
  );
});
