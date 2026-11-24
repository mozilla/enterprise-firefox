/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { updateAppInfo } = ChromeUtils.importESModule(
  "resource://testing-common/AppInfo.sys.mjs"
);
updateAppInfo();

const { ConsoleClient } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs"
);
const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

let gServer;
const gStalledResponses = [];

add_setup(() => {
  gServer = new HttpServer();
  gServer.registerPathHandler("/stall", (request, response) => {
    response.processAsync();
    gStalledResponses.push(response);
  });
  gServer.start(-1);

  registerCleanupFunction(async () => {
    for (const response of gStalledResponses) {
      response.finish();
    }
    await new Promise(resolve => gServer.stop(resolve));
    sinon.restore();
  });
});

add_task(async function test_signout_uses_short_timeout() {
  sinon.stub(ConsoleClient, "getAccessToken").resolves("token");
  sinon
    .stub(ConsoleClient, "constructURI")
    .resolves("https://console.example.com/sso/logout");
  const xhrFetch = sinon.stub(ConsoleClient, "_xhrFetch").resolves({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
  });

  await ConsoleClient.performServerSignout();

  Assert.equal(
    xhrFetch.firstCall.args[1].timeoutMs,
    10000,
    "The signout request uses a shorter timeout than the default"
  );
  sinon.restore();
});

add_task(async function test_signout_does_not_refresh_on_auth_error() {
  sinon.stub(ConsoleClient, "getAccessToken").resolves("token");
  sinon
    .stub(ConsoleClient, "constructURI")
    .resolves("https://console.example.com/sso/logout");
  const xhrFetch = sinon.stub(ConsoleClient, "_xhrFetch").resolves({
    ok: false,
    status: 401,
    text: () => Promise.resolve(""),
  });
  const refreshSession = sinon.stub(ConsoleClient, "_refreshSession");

  await Assert.rejects(
    ConsoleClient.performServerSignout(),
    /failed \(401\)/,
    "A rejected token fails the signout"
  );

  Assert.ok(refreshSession.notCalled, "The session is not refreshed");
  Assert.equal(xhrFetch.callCount, 1, "The signout is not retried");
  sinon.restore();
});

add_task(async function test_xhr_fetch_honors_timeout() {
  const url = `http://localhost:${gServer.identity.primaryPort}/stall`;
  await Assert.rejects(
    ConsoleClient._xhrFetch(url, { method: "POST", timeoutMs: 200 }),
    /NS_ERROR_NET_TIMEOUT/,
    "A stalled request rejects once the given timeout elapses"
  );
});
