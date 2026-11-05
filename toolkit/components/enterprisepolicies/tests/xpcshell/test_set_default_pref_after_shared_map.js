/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { PoliciesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PoliciesHelpers.sys.mjs"
);

const kIntPref = "test.policies.sharedMapIntPref";
const kStringPref = "test.policies.sharedMapStringPref";

add_task(async function test_reapply_after_unset() {
  PoliciesUtils.setDefaultPref(kIntPref, 3, true);
  PoliciesUtils.setDefaultPref(kStringPref, "on", true);

  // Launching a content process snapshots both prefs into the shared pref
  // map, so unsetting them leaves typeless entries in the parent.
  await new Promise(resolve => sendCommand("1;", resolve));

  for (let i = 0; i < 2; i++) {
    PoliciesUtils.unsetAndUnlockPref(kIntPref);
    PoliciesUtils.unsetAndUnlockPref(kStringPref);
    equal(Services.prefs.getPrefType(kIntPref), Services.prefs.PREF_INVALID);
    equal(Services.prefs.getPrefType(kStringPref), Services.prefs.PREF_INVALID);

    PoliciesUtils.setDefaultPref(kIntPref, 3, true);
    PoliciesUtils.setDefaultPref(kStringPref, "on", true);

    equal(Services.prefs.getIntPref(kIntPref), 3);
    ok(Services.prefs.prefIsLocked(kIntPref));
    ok(!Services.prefs.prefHasUserValue(kIntPref));
    equal(Services.prefs.getStringPref(kStringPref), "on");
    ok(Services.prefs.prefIsLocked(kStringPref));
    ok(!Services.prefs.prefHasUserValue(kStringPref));
  }

  PoliciesUtils.unsetAndUnlockPref(kIntPref);
  PoliciesUtils.unsetAndUnlockPref(kStringPref);
});
