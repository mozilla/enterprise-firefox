/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

add_setup(async () => {
  do_get_profile();

  PingServer.start();
  registerCleanupFunction(async () => {
    await PingServer.stop();
  });

  Services.prefs.setIntPref(
    "telemetry.fog.test.localhost_port",
    PingServer.port
  );
  Services.fog.testResetFOG();
});

add_task(async function test_default_application_id() {
  const expectedAppId = AppConstants.MOZ_ENTERPRISE
    ? "firefox-enterprise-desktop"
    : "firefox-desktop";

  PingServer.clearRequests();
  GleanPings.testPing.submit();

  let request;
  do {
    request = await PingServer.promiseNextRequest();
  } while (!request.path.includes("/test-ping/"));

  Assert.ok(
    request.path.startsWith(`/submit/${expectedAppId}/test-ping/`),
    `Ping should be submitted under ${expectedAppId}, got ${request.path}`
  );
});
