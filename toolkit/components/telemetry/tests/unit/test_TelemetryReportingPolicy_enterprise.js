/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/
*/

const { TelemetryReportingPolicy } = ChromeUtils.importESModule(
  "resource://gre/modules/TelemetryReportingPolicy.sys.mjs"
);
const { TelemetryUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/TelemetryUtils.sys.mjs"
);

add_setup(function test_setup() {
  do_get_profile();
  Services.prefs.clearUserPref(TelemetryUtils.Preferences.BypassNotification);
});

add_task(function test_enterprise_never_notifies_data_reporting_policy() {
  Assert.ok(
    Services.prefs.getBoolPref(
      TelemetryUtils.Preferences.DataSubmissionEnabled
    ),
    "Data submission should be enabled"
  );
  Assert.ok(
    !Services.prefs.getBoolPref(TelemetryUtils.Preferences.BypassNotification),
    "The data reporting policy notification should not be bypassed by pref"
  );
  Assert.ok(
    !TelemetryReportingPolicy.testIsUserNotifiedOfDataReportingPolicy(),
    "User should not have been notified of the data reporting policy"
  );
  Assert.ok(
    !TelemetryReportingPolicy.userHasAcceptedTOU(),
    "User should not have accepted the TOU"
  );

  Assert.ok(
    !TelemetryReportingPolicy.testShouldNotify(),
    "The data reporting policy notification should never show on enterprise builds"
  );
});
