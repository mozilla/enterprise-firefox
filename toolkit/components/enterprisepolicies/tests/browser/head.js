/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { EnterprisePolicyTesting, PoliciesPrefTracker } =
  ChromeUtils.importESModule(
    "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
  );

PoliciesPrefTracker.start();

async function setupPolicyEngineWithJson(json, customSchema) {
  PoliciesPrefTracker.restoreDefaultValues();
  const useHttp = Services.prefs.getBoolPref("browser.policies.testUseHttp");
  if (!useHttp) {
    return setupPolicyWithJsonFile(json, customSchema);
  }
  return servePolicyWithJson(json, customSchema, registerCleanupFunction);
}

async function setupPolicyWithJsonFile(json, customSchema) {
  if (typeof json != "object") {
    let filePath = getTestFilePath(json ? json : "non-existing-file.json");
    return EnterprisePolicyTesting.setupPolicyEngineWithJson(
      filePath,
      customSchema
    );
  }
  return EnterprisePolicyTesting.setupPolicyEngineWithJson(json, customSchema);
}

function assertOverHttp() {
  Assert.notEqual(
    EnterprisePolicyTesting._httpd,
    undefined,
    "Making sure HTTP delivery"
  );
}

async function servePolicyWithJson(json, customSchema) {
  return EnterprisePolicyTesting.servePolicyWithJson(json, customSchema);
}

function assert_policy_cleanup() {
  is(
    Services.policies.getActivePolicies(),
    undefined,
    "No policies should be defined"
  );
  is(
    Services.policies.status,
    Ci.nsIEnterprisePolicies.INACTIVE,
    "Engine is inactive at the end of the test"
  );
}

add_task(async function test_simple_policies() {
  let { Policies } = ChromeUtils.importESModule(
    "resource:///modules/policies/Policies.sys.mjs"
  );

  let policy0Ran = false,
    policy1Ran = false,
    policy2Ran = false,
    policy3Ran = false;

  // Implement functions to handle the four simple policies that will be added
  // to the schema.
  Policies.simple_policy0 = {
    onProfileAfterChange(manager, param) {
      is(param, true, "Param matches what was passed in config file");
      policy0Ran = true;
    },
  };

  Policies.simple_policy1 = {
    onProfileAfterChange(manager, param) {
      is(param, true, "Param matches what was passed in config file");
      manager.disallowFeature("feature1", /* needed in content process */ true);
      policy1Ran = true;
    },
  };

  Policies.simple_policy2 = {
    onBeforeUIStartup(manager, param) {
      is(param, true, "Param matches what was passed in config file");
      manager.disallowFeature(
        "feature2",
        /* needed in content process */ false
      );
      policy2Ran = true;
    },
  };

  Policies.simple_policy3 = {
    onAllWindowsRestored(manager, param) {
      is(param, false, "Param matches what was passed in config file");
      policy3Ran = true;
    },
  };

  await setupPolicyEngineWithJson(
    // policies.json
    {
      policies: {
        simple_policy0: true,
        simple_policy1: true,
        simple_policy2: true,
        simple_policy3: false,
      },
    },

    // custom schema
    {
      properties: {
        simple_policy0: {
          type: "boolean",
        },

        simple_policy1: {
          type: "boolean",
        },

        simple_policy2: {
          type: "boolean",
        },

        simple_policy3: {
          type: "boolean",
        },
      },
    }
  );

  is(
    Services.policies.status,
    Ci.nsIEnterprisePolicies.ACTIVE,
    "Engine is active"
  );
  is(
    Services.policies.isAllowed("feature1"),
    false,
    "Dummy feature was disallowed"
  );
  is(
    Services.policies.isAllowed("feature2"),
    false,
    "Dummy feature was disallowed"
  );

  ok(policy0Ran, "Policy 0 ran correctly through BeforeAddons");
  ok(policy1Ran, "Policy 1 ran correctly through onProfileAfterChange");
  ok(policy2Ran, "Policy 2 ran correctly through onBeforeUIStartup");
  ok(policy3Ran, "Policy 3 ran correctly through onAllWindowsRestored");

  await SpecialPowers.spawn(gBrowser.selectedBrowser, [], async function () {
    if (Services.appinfo.processType == Services.appinfo.PROCESS_TYPE_CONTENT) {
      is(
        Services.policies.isAllowed("feature1"),
        false,
        "Correctly disallowed in the content process"
      );
      // Feature 2 wasn't explictly marked as needed in the content process, so it is not marked
      // as disallowed there.
      is(
        Services.policies.isAllowed("feature2"),
        true,
        "Correctly missing in the content process"
      );
    }
  });

  delete Policies.simple_policy0;
  delete Policies.simple_policy1;
  delete Policies.simple_policy2;
  delete Policies.simple_policy3;
});
