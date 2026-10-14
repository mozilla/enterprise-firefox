/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const gDataHome = do_get_profile().clone();
gDataHome.append("appdata");
gDataHome.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
Services.dirsvc.set("UAppData", gDataHome);

const { ConsoleClient } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs"
);
const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

add_task(async function test_cancelled_refresh_cannot_restore_tokens() {
  const setTokens = sinon.stub();
  const feltStub = sinon.stub(Services, "felt").get(() => ({
    isFeltUI: () => true,
    getRefreshToken: () => "old-refresh-token",
    setTokens,
  }));
  const pathsStub = sinon
    .stub(ConsoleClient, "_paths")
    .get(() => ({ TOKEN: "/token" }));
  const uriStub = sinon
    .stub(ConsoleClient, "constructURI")
    .resolves("https://console.example.com/token");
  const { promise: response, resolve: finishRequest } = Promise.withResolvers();
  const xhrStub = sinon.stub(ConsoleClient, "_xhrFetch").returns(response);

  try {
    const refresh = ConsoleClient.refreshTokens();
    await TestUtils.waitForCondition(() => xhrStub.calledOnce);

    ConsoleClient.cancelPendingRefresh();
    Assert.ok(
      xhrStub.firstCall.args[1].signal.aborted,
      "The XHR is cancelled."
    );

    finishRequest({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "late-access-token",
        refresh_token: "late-refresh-token",
        expires_in: 60,
      }),
    });
    await Assert.rejects(
      refresh,
      /Refresh cancelled/,
      "A late reply is ignored."
    );
    Assert.ok(setTokens.notCalled, "A late reply cannot restore tokens.");
  } finally {
    finishRequest();
    await Promise.resolve(ConsoleClient._feltRefreshPromise).catch(() => {});
    xhrStub.restore();
    uriStub.restore();
    pathsStub.restore();
    feltStub.restore();
  }
});

add_task(async function test_old_refresh_cannot_replace_new_session_refresh() {
  const setTokens = sinon.stub();
  const feltStub = sinon.stub(Services, "felt").get(() => ({
    isFeltUI: () => true,
    getRefreshToken: () => "refresh-token",
    setTokens,
  }));
  const pathsStub = sinon
    .stub(ConsoleClient, "_paths")
    .get(() => ({ TOKEN: "/token" }));
  const uriStub = sinon
    .stub(ConsoleClient, "constructURI")
    .resolves("https://console.example.com/token");
  const oldReply = Promise.withResolvers();
  const newReply = Promise.withResolvers();
  const xhrStub = sinon.stub(ConsoleClient, "_xhrFetch");
  xhrStub.onFirstCall().returns(oldReply.promise);
  xhrStub.onSecondCall().returns(newReply.promise);
  const reply = token => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: token,
      refresh_token: `${token}-refresh`,
      expires_in: 60,
    }),
  });

  try {
    const oldRefresh = ConsoleClient.refreshTokens();
    await TestUtils.waitForCondition(() => xhrStub.calledOnce);
    ConsoleClient.cancelPendingRefresh();

    const newRefresh = ConsoleClient.refreshTokens();
    await TestUtils.waitForCondition(() => xhrStub.calledTwice);
    oldReply.resolve(reply("old"));
    await Assert.rejects(oldRefresh, /Refresh cancelled/);
    Assert.notEqual(
      ConsoleClient._feltRefreshPromise,
      null,
      "The old refresh cannot clear the new session's request."
    );

    newReply.resolve(reply("new"));
    await newRefresh;
    Assert.ok(
      setTokens.calledOnceWith("new", "new-refresh", sinon.match.number)
    );
  } finally {
    oldReply.resolve(reply("old"));
    newReply.resolve(reply("new"));
    await Promise.resolve(ConsoleClient._feltRefreshPromise).catch(() => {});
    xhrStub.restore();
    uriStub.restore();
    pathsStub.restore();
    feltStub.restore();
  }
});

add_task(async function test_abort_stops_a_pending_xhr() {
  const server = new HttpServer();
  const { promise: requested, resolve: requestStarted } =
    Promise.withResolvers();
  server.registerPathHandler("/pending", (_, response) => {
    response.processAsync();
    requestStarted(response);
  });
  server.start(-1);

  const controller = new AbortController();
  const fetch = ConsoleClient._xhrFetch(
    `http://localhost:${server.identity.primaryPort}/pending`,
    { signal: controller.signal }
  );
  const response = await requested;

  try {
    controller.abort();
    await Assert.rejects(
      fetch,
      /Request cancelled/,
      "The XHR reports the requested cancellation promptly."
    );
  } finally {
    response.finish();
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(async function test_browser_refresh_results_are_correlated() {
  const sandbox = sinon.createSandbox();
  const send = sandbox.stub();
  const setTokens = sandbox.stub();
  sandbox.stub(Services, "felt").get(() => ({
    isFeltBrowser: () => true,
    refreshTokens: send,
    setTokens,
  }));
  sandbox.stub(ConsoleClient, "_syncCrashReporterAuthToken");
  const reply = (request, error = "") =>
    ConsoleClient.observe(
      null,
      "felt-firefox-token-refresh-result",
      JSON.stringify({
        request_id: request.id,
        access_token: `token-${request.id}`,
        expires_at: 4102444800,
        error,
      })
    );
  try {
    const first = ConsoleClient._refreshSession();
    const old = ConsoleClient._refreshRequest;
    const joined = ConsoleClient._refreshSession();
    Assert.equal(send.callCount, 1, "Concurrent callers share an IPC request");
    ConsoleClient._onBrowserRefreshTimeout(old);
    await Promise.all(
      [first, joined].map(async promise => {
        await Assert.rejects(promise, /NS_ERROR_NET_TIMEOUT/);
      })
    );
    const second = ConsoleClient._refreshSession();
    const current = ConsoleClient._refreshRequest;
    Assert.equal(send.callCount, 2);
    Assert.notEqual(current.id, old.id);
    reply(old);
    reply(old, "ConsoleClientXHRError");
    ConsoleClient._onBrowserRefreshTimeout(old);
    ConsoleClient.observe(null, "felt-firefox-access-token-refreshed");
    Assert.equal(
      ConsoleClient._refreshRequest,
      current,
      "Late results, stale timers and untagged updates cannot finish the retry"
    );
    Assert.ok(setTokens.notCalled, "Stale tokens are not installed");
    reply(current);
    await second;
    Assert.ok(setTokens.calledOnceWith(`token-${current.id}`, "", 4102444800));
    Assert.equal(ConsoleClient._refreshRequest, null);

    const failed = ConsoleClient._refreshSession();
    const failedRequest = ConsoleClient._refreshRequest;
    reply(failedRequest, "ConsoleClientXHRError");
    await Assert.rejects(failed, /ConsoleClientXHRError/);
    Assert.equal(ConsoleClient._refreshRequest, null, "Failure allows a retry");

    send.throws(new Error("IPC disconnected"));
    await Assert.rejects(ConsoleClient._refreshSession(), /IPC disconnected/);
    Assert.equal(
      ConsoleClient._refreshRequest,
      null,
      "Send failure cleans up immediately"
    );
    send.resetBehavior();
    const afterFailure = ConsoleClient._refreshSession();
    reply(ConsoleClient._refreshRequest);
    await afterFailure;
  } finally {
    ConsoleClient._finishBrowserRefresh(ConsoleClient._refreshRequest);
    sandbox.restore();
  }
});

add_task(async function test_shutdown_retires_browser_refresh() {
  const { ForcedQuitHandler } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/enterprise/modules/ForcedQuitHandler.sys.mjs"
  );
  const sandbox = sinon.createSandbox();
  const setTokens = sandbox.stub();
  sandbox.stub(Services, "felt").get(() => ({
    isFeltBrowser: () => true,
    refreshTokens: sandbox.stub(),
    setTokens,
  }));
  sandbox.stub(ForcedQuitHandler, "quitIgnoringCanClose");
  try {
    const refresh = ConsoleClient._refreshSession();
    const request = ConsoleClient._refreshRequest;
    ConsoleClient.observe(null, "felt-firefox-shutdown");
    await Assert.rejects(refresh, /Browser shutting down/);
    await Assert.rejects(
      ConsoleClient._refreshSession(),
      /Browser shutting down/
    );
    ConsoleClient.observe(
      null,
      "felt-firefox-token-refresh-result",
      JSON.stringify({
        request_id: request.id,
        access_token: "late-token",
        expires_at: 4102444800,
        error: "",
      })
    );
    Assert.ok(
      setTokens.notCalled,
      "Shutdown prevents a late token from being installed"
    );
    Assert.equal(ConsoleClient._refreshRequest, null);
  } finally {
    ConsoleClient._refreshShuttingDown = false;
    ConsoleClient._finishBrowserRefresh(ConsoleClient._refreshRequest);
    sandbox.restore();
  }
});
