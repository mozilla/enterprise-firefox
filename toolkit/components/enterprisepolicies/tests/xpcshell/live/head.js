/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { EnterprisePolicyTesting, PoliciesPrefTracker } =
  ChromeUtils.importESModule(
    "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
  );
const { updateAppInfo } = ChromeUtils.importESModule(
  "resource://testing-common/AppInfo.sys.mjs"
);

updateAppInfo({
  name: "XPCShell",
  ID: "xpcshell@tests.mozilla.org",
  version: "155",
  platformVersion: "155",
});

// Initialize the policy engine while remote (live) policies are still disabled,
// so this startup does not attempt an unstubbed remote fetch. Each test then
// restarts the engine with remote policies enabled via
// setupEngineWithRemotePolicies.
let policies = Cc["@mozilla.org/enterprisepolicies;1"].getService(
  Ci.nsIObserver
);
policies.observe(null, "policies-startup", null);

add_setup(async function () {
  PoliciesPrefTracker.start();

  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });
  Services.prefs.setBoolPref("enterprise.policies.live.enabled", true);
  EnterprisePolicyTesting.stubFirefoxConfig({ pollingFrequency: 500 });

  // Set the enterprise console address before any Proxy policy applies so the
  // console-exclusion path resolves deterministically for every test.
  Services.prefs.setStringPref(
    "enterprise.console.address",
    "https://console.example.com"
  );

  registerCleanupFunction(() => {
    Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
    if (EnterprisePolicyTesting.remotePoliciesStub) {
      EnterprisePolicyTesting.remotePoliciesStub.restore();
      EnterprisePolicyTesting.remotePoliciesStub = null;
    }
    Services.prefs.clearUserPref("enterprise.policies.live.enabled");
    EnterprisePolicyTesting.firefoxConfigStub.restore();
    EnterprisePolicyTesting.firefoxConfigStub = null;
    Services.prefs.clearUserPref("enterprise.console.address");
    PoliciesPrefTracker.stop();
  });
});
