/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { EnterprisePolicyTesting, PoliciesPrefTracker } =
  ChromeUtils.importESModule(
    "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
  );

const { Policies } = ChromeUtils.importESModule(
  "resource:///modules/policies/Policies.sys.mjs"
);

EnterprisePolicyTesting.pathResolver = getTestFilePath;

const POLICY_PARAM_STATE = {
  DEFAULT: "default",
  APPLIED: "applied",
  APPLIED_LOCAL_POLICY: "applied-by-local-policy",
  APPLIED_REMOTE_POLICY: "applied-by-remote-policy",
  UPDATED_BY_REMOTE_POLICY: "updated-by-remote-policy",
  REMOVED: "removed",
};

add_setup(async () => {
  PoliciesPrefTracker.start();

  // The engine initializes during browser startup, before this setup runs.
  // Enabling remote policies via the manifest would make the startup init
  // attempt an unstubbed remote fetch, fail, and shut the browser down. Instead
  // enable remote here, serve an empty policy set, the policy engines get
  // restarted in each test file
  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });
  await SpecialPowers.pushPrefEnv({
    set: [["enterprise.policies.live.enabled", true]],
  });

  registerCleanupFunction(() => {
    Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
    if (EnterprisePolicyTesting.remotePoliciesStub) {
      EnterprisePolicyTesting.remotePoliciesStub.restore();
      EnterprisePolicyTesting.remotePoliciesStub = null;
    }
    PoliciesPrefTracker.stop();
  });
});
