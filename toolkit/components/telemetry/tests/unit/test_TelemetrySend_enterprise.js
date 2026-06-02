/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/
*/

const { TelemetryController } = ChromeUtils.importESModule(
  "resource://gre/modules/TelemetryController.sys.mjs"
);
const { TelemetrySend } = ChromeUtils.importESModule(
  "resource://gre/modules/TelemetrySend.sys.mjs"
);
const { TelemetryUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/TelemetryUtils.sys.mjs"
);
const TEST_PING_TYPE = "test-enterprise-ping";

add_setup(async function test_setup() {
  do_get_profile();
  await loadAddonManager(
    "xpcshell@tests.mozilla.org",
    "XPCShell",
    "1",
    "1.9.2"
  );
  finishAddonManagerStartup();
  fakeIntlReady();
  await setEmptyPrefWatchlist();

  await TelemetryController.testSetup();
});

add_task(async function test_enterprise_telemetry_server_empty() {
  let server = Services.prefs.getStringPref(
    TelemetryUtils.Preferences.Server,
    ""
  );
  Assert.equal(
    server,
    "",
    "Telemetry server should be empty on enterprise builds"
  );

  Assert.ok(
    Services.prefs.prefIsLocked(TelemetryUtils.Preferences.Server),
    "Telemetry server pref should be locked on enterprise builds"
  );
});

add_task(async function test_enterprise_no_pings_sent() {
  Assert.ok(
    !TelemetrySend.sendingEnabled(),
    "sendingEnabled() should return false in enterprise builds"
  );

  PingServer.start();

  let receivedPing = false;
  PingServer.registerPingHandler(() => {
    receivedPing = true;
  });

  await TelemetryController.submitExternalPing(TEST_PING_TYPE, {});

  Assert.ok(
    !receivedPing,
    "No pings should reach the server on enterprise builds"
  );

  Assert.equal(
    TelemetrySend.pendingPingCount,
    0,
    "There should be no pending pings in enterprise builds"
  );

  PingServer.resetPingHandler();
  await PingServer.stop();
});
