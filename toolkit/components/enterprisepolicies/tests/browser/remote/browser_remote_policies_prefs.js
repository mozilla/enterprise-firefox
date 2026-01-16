/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { setAndLockPref, unsetAndUnlockPref } = ChromeUtils.importESModule(
  "resource:///modules/policies/Policies.sys.mjs"
);

const PREF_VALUE = {
  DEFAULT: "default",
  USER_CHANGED: "user-changed",
  POLICY_DEFAULT: "policy-default",
  POLICY_CHANGED: "policy-changed",
}

add_task(async function test_simple_policy_pref_setAndLock() {
  
  const prefName = "browser.tests.some_random_pref";

  try {
    Services.prefs.getStringPref(prefName);
    ok(false, `Pref ${prefName} exists, this should not happen`);
  } catch {
    ok(true, `Pref ${prefName} does not exist`);
  }

  let defaults = Services.prefs.getDefaultBranch("");
  defaults.setStringPref(prefName, PREF_VALUE.DEFAULT);

  // Assert default pref value
  is(
    Services.prefs.getStringPref(prefName),
    PREF_VALUE.DEFAULT,
    "Correct default pref value returned via Services.prefs."
  );
  is(
    defaults.getStringPref(prefName),
    PREF_VALUE.DEFAULT,
    "Correct default pref value returned via defaults."
  );

  Services.prefs.setStringPref(prefName, PREF_VALUE.USER_CHANGED);

  // Assert user value works
  is(
    Services.prefs.getStringPref(prefName),
    PREF_VALUE.USER_CHANGED,
    "user pref value returned via Services.prefs."
  );
  is(
    defaults.getStringPref(prefName),
    PREF_VALUE.DEFAULT,
    "default pref value returned via defaults."
  );

  // Assert not locked
  is(
    false,
    Services.prefs.prefIsLocked(prefName),
    "Pref reports as not locked"
  );

  const customSchema = {
    properties: {
      SetSomePref: {
        type: "string",
      },
    },
  };

  Policies.SetSomePref = {
    onBeforeUIStartup(manager, param) {
      if (param) {
        setAndLockPref(prefName, param);
      }
    },
    onRemove(manager, oldParams) {
      if (oldParams) {
        unsetAndUnlockPref(prefName);
      }
    },
  };

  await setupPolicyEngineWithJson(
    {
      policies: {
        SetSomePref: PREF_VALUE.POLICY_DEFAULT,
      },
    },
    customSchema
  );

  // Assert pref value set and locked, default value returned
  is(
    Services.prefs.getStringPref(prefName),
    PREF_VALUE.POLICY_DEFAULT,
    "new default pref value returned via Services.prefs."
  );
  is(
    defaults.getStringPref(prefName),
    PREF_VALUE.POLICY_DEFAULT,
    "new default pref value returned via defaults."
  );
  is(true, Services.prefs.prefIsLocked(prefName), "Pref reports as locked");

  await EnterprisePolicyTesting.applyRemotePolicies(
    {
      policies: {
        SetSomePref: PREF_VALUE.POLICY_CHANGED,
      },
    },
  );

  // Assert pref value set and locked, default value returned
  is(
    Services.prefs.getStringPref(prefName),
    PREF_VALUE.POLICY_CHANGED,
    "new changed pref value returned via Services.prefs."
  );
  is(
    defaults.getStringPref(prefName),
    PREF_VALUE.POLICY_CHANGED,
    "new changed pref value returned via defaults."
  );
  is(true, Services.prefs.prefIsLocked(prefName), "Pref remains as locked");

  await EnterprisePolicyTesting.applyRemotePolicies(
    {
      policies: {},
    },
  );

  // Assert original default pref and user value returned again
  is(
    Services.prefs.getStringPref(prefName),
    PREF_VALUE.USER_CHANGED,
    "original user pref value returned via Services.prefs."
  );
  is(
    defaults.getStringPref(prefName),
    PREF_VALUE.DEFAULT,
    "original default pref value returned via defaults."
  );

  is(false, Services.prefs.prefIsLocked(prefName), "Pref reports as unlocked");

  delete Policies.SetSomePref;

  Services.prefs.deleteBranch(prefName);
});

 