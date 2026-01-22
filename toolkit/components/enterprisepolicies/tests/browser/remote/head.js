/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/* import-globals-from ../head.js */

"use strict";

Services.scriptloader.loadSubScript(
  "chrome://mochitests/content/browser/toolkit/components/enterprisepolicies/tests/browser/head.js",
  this
);

const POLICY_PARAM_STATE = {
  DEFAULT: "default",
  APPLIED: "applied",
  APPLIED_LOCAL_POLICY: "applied-by-local-policy",
  APPLIED_REMOTE_POLICY: "applied-by-remote-policy",
  UPDATED: "updated",
  REMOVED: "removed",
};

add_setup(async () => {
  registerCleanupFunction(async () => {
    Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
    if (EnterprisePolicyTesting.remotePoliciesStub) {
      EnterprisePolicyTesting.remotePoliciesStub.restore();
      EnterprisePolicyTesting.remotePoliciesStub = null;
    }
  });
});

/**
 * Set up a policy engine that combined local and regularly fetched remote policies.
 *
 * @param {object} localPolicies Policies to be read from a local policies.json
 * @param {object} remotePolicies Policies to be fetched from a stubed ConsoleClient endpoint
 * @param {object} customSchema
 *
 * @returns {Promise} Promise that resolves once local and remote policies are applied after a policy engine restart.
 */
async function setupPolicyEngineWithCombinedPolicyProvider(
  localPolicies,
  remotePolicies,
  customSchema
) {
  PoliciesPrefTracker.restoreDefaultValues();

  // Stub remote policies endpoint
  const remotePoliciesAppliedPromise =
    EnterprisePolicyTesting.applyRemotePolicies(remotePolicies, false);

  // Put local policies in place (local policies.json file)
  const localPoliciesAppliedPromise = setupPolicyWithJsonFile(
    localPolicies,
    customSchema
  );

  // Waiting for the "EnterprisePolicies:PolicyUpdatesApplied" notification
  return Promise.all([
    localPoliciesAppliedPromise,
    remotePoliciesAppliedPromise,
  ]);
}
