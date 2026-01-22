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

let policyValue = POLICY_PARAM_STATE.DEFAULT;

const TestPolicy = {
  onBeforeUIStartup(manager, param) {
    policyValue = param;
  },
  onRemove(_manager, _oldParam) {
    policyValue = POLICY_PARAM_STATE.REMOVED;
  },
};

add_setup(async () => {
  Policies.TestPolicy = TestPolicy;

  registerCleanupFunction(async () => {
    delete Policies.TestPolicy;
  });
});

add_task(async function test_policy_update_apply_new_policy() {
  policyValue = POLICY_PARAM_STATE.DEFAULT;

  await setupPolicyEngineWithJson(
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
    policyValue,
    POLICY_PARAM_STATE.DEFAULT,
    "Expected the default policy parameter."
  );

  const policies = {
    policies: {
      TestPolicy: POLICY_PARAM_STATE.APPLIED,
    },
  };

  await EnterprisePolicyTesting.applyRemotePolicies(policies);

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    { TestPolicy: POLICY_PARAM_STATE.APPLIED },
    "Expected remote policy TestPolicy with parameter APPLIED."
  );
});

add_task(async function test_policy_update_apply_policy_param_update() {
  policyValue = POLICY_PARAM_STATE.DEFAULT;

  await setupPolicyEngineWithJson(
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

  policyValue = POLICY_PARAM_STATE.DEFAULT;

  const policies = {
    policies: {
      TestPolicy: POLICY_PARAM_STATE.UPDATED,
    },
  };

  await EnterprisePolicyTesting.applyRemotePolicies(policies);

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    { TestPolicy: POLICY_PARAM_STATE.UPDATED },
    "Expected remote policy TestPolicy with parameter UPDATED."
  );
});

add_task(async function test_policy_update_remove_old_policy() {
  policyValue = POLICY_PARAM_STATE.DEFAULT;

  await setupPolicyEngineWithJson(
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

  const policies = {
    policies: {},
  };

  await EnterprisePolicyTesting.applyRemotePolicies(policies);

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    {},
    "Expected remote policy TestPolicy to be removed."
  );
  Assert.equal(
    policyValue,
    POLICY_PARAM_STATE.REMOVED,
    "Expected the policy parameter to be of state REMOVED."
  );
});

add_task(async function test_policy_update_no_changes() {
  policyValue = POLICY_PARAM_STATE.DEFAULT;

  await setupPolicyEngineWithJson(
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

  // This is not really representative of how things can happen but rather to
  // verify that the policy's callback was not called a second time.
  //
  // Intended behavior is:
  //  - poll
  //    + get policy1 with param X=Y
  //    + apply policy1 with callback onBeforeUIStartup
  //  - poll
  //    + get policy1 with param X=Y
  //    + no change to policy1 so no call to onBeforeUIStartup
  //    + no state changed
  //
  // => This is where check happens because we locally changed the state, so
  //    it is expected that the state stays this way (and is technically
  //    incorrect WRT policy at the moment)
  //

  // Revert back to DEFAULT
  policyValue = POLICY_PARAM_STATE.DEFAULT;

  // Wait for next policy update to complete
  await EnterprisePolicyTesting.awaitNextPolicyUpdate();

  // Verify that the policy's callback wasn't called a second time.
  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    { TestPolicy: POLICY_PARAM_STATE.APPLIED },
    "Expected no changes to the active policy specifications."
  );
  Assert.equal(
    policyValue,
    POLICY_PARAM_STATE.DEFAULT,
    "Expected local changes to policy parameters to not get overridden."
  );

  const policies = {
    policies: {},
  };

  await EnterprisePolicyTesting.applyRemotePolicies(policies);

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    {},
    "Expected remote policy TestPolicy to be removed."
  );
  Assert.equal(
    policyValue,
    POLICY_PARAM_STATE.REMOVED,
    "Expected the policy parameter to be of state REMOVED."
  );
});
