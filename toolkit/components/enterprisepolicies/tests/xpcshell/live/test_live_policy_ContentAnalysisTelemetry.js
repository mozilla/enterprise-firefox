/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const ENABLED_PREF = "browser.contentanalysis.enterprise.telemetry.enabled";
const URL_LOGGING_PREF =
  "browser.contentanalysis.enterprise.telemetry.urlLogging";

async function updatePolicies(policy) {
  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies(policy);
  await updateApplied;
}

// Bug 2074952: the settings stay locked to their defaults when the policy is
// updated or removed live, so user values set beforehand never take effect.
add_task(async function test_settings_stay_locked_when_updated_and_removed() {
  Services.prefs.setBoolPref(ENABLED_PREF, false);
  Services.prefs.setCharPref(URL_LOGGING_PREF, "none");
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(ENABLED_PREF);
    Services.prefs.clearUserPref(URL_LOGGING_PREF);
  });

  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        ContentAnalysisTelemetry: { Enabled: false, UrlLogging: "domain" },
      },
    },
    null
  );
  EnterprisePolicyTesting.checkPolicyPref(ENABLED_PREF, false, true);
  EnterprisePolicyTesting.checkPolicyPref(URL_LOGGING_PREF, "domain", true);

  await updatePolicies({
    policies: { ContentAnalysisTelemetry: { Enabled: true } },
  });
  EnterprisePolicyTesting.checkPolicyPref(ENABLED_PREF, true, true);
  EnterprisePolicyTesting.checkPolicyPref(URL_LOGGING_PREF, "full", true);

  await updatePolicies({ policies: {} });
  EnterprisePolicyTesting.checkPolicyPref(ENABLED_PREF, true, true);
  EnterprisePolicyTesting.checkPolicyPref(URL_LOGGING_PREF, "full", true);
});
