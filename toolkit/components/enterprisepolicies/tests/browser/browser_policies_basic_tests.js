/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_setup(function test_set_local_file_usage() {
  SpecialPowers.pushPrefEnv({ set: [["browser.policies.testUseHttp", false]] });
});

add_task(async function test_policy_cleanup() {
  await EnterprisePolicyTesting.setupPolicyEngineWithJson("");
  assert_policy_cleanup();
});
