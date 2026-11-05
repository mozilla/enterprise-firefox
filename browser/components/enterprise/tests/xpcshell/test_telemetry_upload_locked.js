/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Bug 2046816: enterprise security events are sent through Glean, so the
// user must not be able to turn telemetry upload off.

const UPLOAD_PREF = "datareporting.healthreport.uploadEnabled";
const LOCALHOST_PREF = "telemetry.fog.test.localhost_port";

do_get_profile();

// The test profile sets the port to -1, which keeps Glean collecting no
// matter what the upload pref says. A positive port gates collection on the
// upload pref alone while keeping any ping on localhost.
Services.prefs.setIntPref(LOCALHOST_PREF, 45326);
Services.fog.initializeFOG();

add_task(function test_upload_pref_is_locked_on() {
  Assert.ok(Services.prefs.prefIsLocked(UPLOAD_PREF), "Upload pref is locked");
  Assert.ok(
    Services.prefs.getDefaultBranch("").getBoolPref(UPLOAD_PREF),
    "Upload is enabled by default"
  );
  Assert.ok(Services.prefs.getBoolPref(UPLOAD_PREF), "Upload is enabled");
});

add_task(function test_user_value_cannot_disable_upload() {
  const value = 42;
  Glean.testOnly.meaningOfLife.set(value);
  Assert.equal(
    Glean.testOnly.meaningOfLife.testGetValue("test-ping"),
    value,
    "Glean is collecting"
  );

  Services.prefs.setBoolPref(UPLOAD_PREF, false);
  Assert.ok(
    Services.prefs.getBoolPref(UPLOAD_PREF),
    "A user value does not disable upload"
  );
  Assert.equal(
    Glean.testOnly.meaningOfLife.testGetValue("test-ping"),
    value,
    "Glean keeps collecting after the attempt to disable upload"
  );

  Services.prefs.clearUserPref(UPLOAD_PREF);
});
