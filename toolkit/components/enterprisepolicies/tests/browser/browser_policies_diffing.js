/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_setup(async function test_set_http_server_usage() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.policies.live_polling_freq", 250],
      ["browser.policies.testUseHttp", true],
    ],
  });

  await EnterprisePolicyTesting.servePolicyWithJson(
    {},
    {},
    registerCleanupFunction
  );

  if (Services.prefs.getBoolPref("browser.policies.testUseHttp")) {
    assertOverHttp();
  }
});

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Policies: "resource:///modules/policies/Policies.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

add_task(async function test_simple_policy_removal() {
  const customSchema = {
    properties: {
      BlockSomePage: {
        type: "boolean",
      },
    },
  };

  let blockSomePageApplied = false;

  // Inspired by BlockAboutConfig
  lazy.Policies.BlockSomePage = {
    onBeforeUIStartup(manager, param) {
      if (param) {
        blockSomePageApplied = true;
      }
    },
    onRemove(manager, oldParam) {
      if (oldParam) {
        // Previous policy param was "true" so revert and disable the blocking
        blockSomePageApplied = false;
      }
    },
  };

  await setupPolicyEngineWithJson(
    {
      policies: {
        BlockSomePage: true,
      },
    },
    customSchema
  );

  ok(blockSomePageApplied, "BlockSomePage enabled");

  await setupPolicyEngineWithJson(
    {
      policies: {},
    },
    customSchema
  );

  ok(!blockSomePageApplied, "BlockSomePage disabled");

  delete lazy.Policies.BlockSomePage;
});

add_task(async function test_simple_policy_stays() {
  const customSchema = {
    properties: {
      BlockAnotherPage: {
        type: "boolean",
      },
    },
  };

  let blockAnotherPageApplied = false;

  // Inspired by BlockAboutConfig
  lazy.Policies.BlockAnotherPage = {
    onBeforeUIStartup(manager, param) {
      info(`BlockAnotherPage.onBeforeUIStartup(${param})`);
      if (param) {
        blockAnotherPageApplied = true;
      }
    },
    onRemove(manager, oldParam) {
      info(`BlockAnotherPage.onRemove(${oldParam})`);
      if (oldParam) {
        // Previous policy param was "true" so revert and disable the blocking
        blockAnotherPageApplied = false;
      }
    },
  };

  await setupPolicyEngineWithJson(
    {
      policies: {
        BlockAnotherPage: true,
      },
    },
    customSchema
  );

  // We received payload and applied once
  ok(blockAnotherPageApplied, "BlockAnotherPage enabled");

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

  blockAnotherPageApplied = false;

  // polling happens on a specific frequency so wait enough to be certain
  await new Promise(resolve => lazy.setTimeout(resolve, 500));

  ok(!blockAnotherPageApplied, "BlockAnotherPage not re-enabled by policy");

  // Set back the correct value
  blockAnotherPageApplied = true;

  // Now publish a new instance where the policy has been removed
  await setupPolicyEngineWithJson(
    {
      policies: {},
    },
    customSchema
  );

  // Policy being removed it means the blocking should get lifted
  ok(!blockAnotherPageApplied, "BlockAnotherPage disabled");

  delete lazy.Policies.BlockAnotherPage;
});

add_task(async function policy_cleanup() {
  await EnterprisePolicyTesting.servePolicyWithJson({}, {});
});
