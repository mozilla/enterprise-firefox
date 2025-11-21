/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// TODO: We only test the RemotePoliciesProvider here, it would be nice
// to enhance with testing combinations of providers

add_setup(async function test_set_http_server_usage() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.policies.testUseHttp", true]],
  });

  await EnterprisePolicyTesting.servePolicyWithJson(
    {},
    {},
    registerCleanupFunction
  );
  assertOverHttp();
});

add_task(test_simple_policies);

add_task(async function test_policy_cleanup() {
  await EnterprisePolicyTesting.servePolicyWithJson({}, {});
  assert_policy_cleanup();
});
