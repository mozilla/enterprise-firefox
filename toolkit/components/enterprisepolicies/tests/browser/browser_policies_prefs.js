/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Policies: "resource:///modules/policies/Policies.sys.mjs",
  PoliciesPrefTracker:
    "resource://testing-common/EnterprisePolicyTesting.sys.mjs",
  setAndLockPref: "resource:///modules/policies/Policies.sys.mjs",
  unsetAndUnlockPref: "resource:///modules/policies/Policies.sys.mjs",
});

add_setup(async function test_set_http_server_usage() {
  lazy.PoliciesPrefTracker.stop();

  await SpecialPowers.pushPrefEnv({
    set: [["browser.policies.testUseHttp", true]],
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

add_task(async function test_simple_policy_pref_setAndLock() {
  const customSchema = {
    properties: {
      SetSomePref: {
        type: "boolean",
      },
    },
  };

  const prefName = "browser.tests.some_random_pref";
  // just something random
  const prefValue = "fcf57517-a524-4468-bff7-0817b2ad6a31";

  try {
    Services.prefs.getStringPref(prefName);
    ok(false, `Pref ${prefName} exists, this should not happen`);
  } catch {
    ok(true, `Pref ${prefName} does not exists`);
  }

  lazy.Policies.SetSomePref = {
    onBeforeUIStartup(manager, param) {
      if (param) {
        lazy.setAndLockPref(prefName, `${prefValue}-policyDefault`);
      }
    },
    onRemove(manager, oldParams) {
      if (oldParams) {
        lazy.unsetAndUnlockPref(prefName, `${prefValue}-policyDefault`);
      }
    },
  };

  let defaults = Services.prefs.getDefaultBranch("");
  defaults.setStringPref(prefName, prefValue);

  // Assert default pref value
  is(
    Services.prefs.getStringPref(prefName),
    prefValue,
    "default pref value returned via Services.prefs."
  );
  is(
    defaults.getStringPref(prefName),
    prefValue,
    "default pref value returned via defaults."
  );

  Services.prefs.setStringPref(prefName, `${prefValue}-user`);

  // Assert user value works
  is(
    Services.prefs.getStringPref(prefName),
    `${prefValue}-user`,
    "user pref value returned via Services.prefs."
  );
  is(
    defaults.getStringPref(prefName),
    prefValue,
    "default pref value returned via defaults."
  );

  // Assert not locked
  is(
    false,
    Services.prefs.prefIsLocked(prefName),
    "Pref reports as not locked"
  );

  await setupPolicyEngineWithJson(
    {
      policies: {
        SetSomePref: true,
      },
    },
    customSchema
  );

  // Assert pref value set and locked, default value returned
  is(
    Services.prefs.getStringPref(prefName),
    `${prefValue}-policyDefault`,
    "new default pref value returned via Services.prefs."
  );
  is(
    defaults.getStringPref(prefName),
    `${prefValue}-policyDefault`,
    "new default pref value returned via defaults."
  );
  is(true, Services.prefs.prefIsLocked(prefName), "Pref reports as locked");

  await setupPolicyEngineWithJson(
    {
      policies: {},
    },
    customSchema
  );

  // Assert original default pref and user value returned again
  is(
    Services.prefs.getStringPref(prefName),
    `${prefValue}-user`,
    "original user pref value returned via Services.prefs."
  );
  is(
    defaults.getStringPref(prefName),
    prefValue,
    "original default pref value returned via defaults."
  );
  is(false, Services.prefs.prefIsLocked(prefName), "Pref reports as locked");

  delete lazy.Policies.SetSomePref;

  Services.prefs.deleteBranch(prefName);
});

add_task(async function policy_cleanup() {
  await EnterprisePolicyTesting.servePolicyWithJson({}, {});
});
