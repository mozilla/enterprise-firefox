/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ConsoleClient } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/ConsoleClient.sys.mjs"
);
const { DevicePosture, PostureMonitor } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/DevicePosture.sys.mjs"
);
const { FeltProcessParent } = ChromeUtils.importESModule(
  "chrome://felt/content/FeltProcessParent.sys.mjs"
);
const { FeltLocking } = ChromeUtils.importESModule(
  "chrome://felt/content/FeltLocking.sys.mjs"
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
      /NS_BINDING_ABORTED/,
      "The XHR stops promptly."
    );
  } finally {
    response.finish();
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(
  async function test_server_signout_uses_captured_token_and_short_timeout() {
    const pathsStub = sinon
      .stub(ConsoleClient, "_paths")
      .get(() => ({ SIGNOUT: "/signout" }));
    const uriStub = sinon
      .stub(ConsoleClient, "constructURI")
      .resolves("https://console.example.com/signout");
    const xhrStub = sinon
      .stub(ConsoleClient, "_xhrFetch")
      .resolves({ ok: true, status: 200 });

    try {
      await ConsoleClient.performServerSignoutWithToken("captured-token", 5000);
      Assert.ok(xhrStub.calledOnce, "The signout POST was attempted.");
      const [url, options] = xhrStub.firstCall.args;
      Assert.equal(url, "https://console.example.com/signout");
      Assert.equal(options.method, "POST");
      Assert.equal(options.headers.Authorization, "Bearer captured-token");
      Assert.equal(options.timeoutMs, 5000);
    } finally {
      xhrStub.restore();
      uriStub.restore();
      pathsStub.restore();
    }
  }
);

add_task(
  async function test_completed_posture_cannot_start_refresh_after_logout() {
    const collectStub = sinon.stub(DevicePosture, "collect").resolves({});
    const refreshStub = sinon.stub(ConsoleClient, "refreshTokens");
    const wasSessionOver = PostureMonitor._isSessionOver;

    try {
      PostureMonitor._isSessionOver = () => true;
      await PostureMonitor._poll();
      Assert.ok(collectStub.calledOnce, "The posture collection finished.");
      Assert.ok(refreshStub.notCalled, "No refresh starts after logout.");
    } finally {
      PostureMonitor._isSessionOver = wasSessionOver;
      refreshStub.restore();
      collectStub.restore();
    }
  }
);

add_task(async function test_stopped_monitor_ignores_late_refresh_failure() {
  const collectStub = sinon.stub(DevicePosture, "collect").resolves({});
  const pending = Promise.withResolvers();
  const refreshStub = sinon
    .stub(ConsoleClient, "refreshTokens")
    .returns(pending.promise);
  const rejected = sinon.stub();
  const wasSessionOver = PostureMonitor._isSessionOver;
  const wasRefreshRejected = PostureMonitor._onRefreshRejected;

  try {
    PostureMonitor._isSessionOver = () => false;
    PostureMonitor._onRefreshRejected = rejected;
    const poll = PostureMonitor._poll();
    await TestUtils.waitForCondition(() => refreshStub.calledOnce);
    PostureMonitor.stop();
    const error = new Error("old session");
    error.name = "ReauthRequiredError";
    pending.reject(error);
    await poll;
    Assert.ok(
      rejected.notCalled,
      "An old failure cannot end the next session."
    );
  } finally {
    pending.resolve();
    PostureMonitor._isSessionOver = wasSessionOver;
    PostureMonitor._onRefreshRejected = wasRefreshRejected;
    refreshStub.restore();
    collectStub.restore();
  }
});

add_task(async function test_abandoned_poll_cannot_block_new_session_poll() {
  const collectStub = sinon.stub(DevicePosture, "collect").resolves({});
  const oldReply = Promise.withResolvers();
  const newReply = Promise.withResolvers();
  const refreshStub = sinon.stub(ConsoleClient, "refreshTokens");
  refreshStub.onFirstCall().returns(oldReply.promise);
  refreshStub.onSecondCall().returns(newReply.promise);
  const applied = sinon.stub();
  const wasSessionOver = PostureMonitor._isSessionOver;
  const wasRefreshed = PostureMonitor._onRefreshed;

  try {
    PostureMonitor._isSessionOver = () => false;
    PostureMonitor._onRefreshed = applied;
    const oldPoll = PostureMonitor.tick();
    await TestUtils.waitForCondition(() => refreshStub.calledOnce);

    PostureMonitor.abandon();
    const newPoll = PostureMonitor.tick();
    await TestUtils.waitForCondition(() => refreshStub.calledTwice);
    oldReply.resolve({ postureSubmitted: false, id: "old" });
    await oldPoll;
    Assert.equal(
      PostureMonitor._inFlight,
      newPoll,
      "The old poll cannot release the new session's slot."
    );

    newReply.resolve({ postureSubmitted: false, id: "new" });
    await newPoll;
    Assert.ok(applied.calledOnceWith(sinon.match({ id: "new" })));
  } finally {
    oldReply.resolve({ postureSubmitted: false });
    newReply.resolve({ postureSubmitted: false });
    PostureMonitor.abandon();
    PostureMonitor._isSessionOver = wasSessionOver;
    PostureMonitor._onRefreshed = wasRefreshed;
    refreshStub.restore();
    collectStub.restore();
  }
});

add_task(async function test_network_loss_logout_does_not_wait_for_server() {
  const { promise: exited, resolve: finishExit } = Promise.withResolvers();
  const shutdown = sinon.stub();
  const feltStub = sinon.stub(Services, "felt").get(() => ({
    shutdownFirefox: shutdown,
    getAccessTokenIfValid: () => "captured-token",
  }));
  const message = sinon.stub();
  const cpmmStub = sinon
    .stub(Services, "cpmm")
    .get(() => ({ sendAsyncMessage: message }));
  const cancelStub = sinon.stub(ConsoleClient, "cancelPendingRefresh");
  const signoutStub = sinon
    .stub(ConsoleClient, "performServerSignoutWithToken")
    .returns(new Promise(() => {}));
  const clearStub = sinon.stub(FeltLocking, "clearLockAndTokens");
  const actor = Object.create(FeltProcessParent.prototype);
  actor.proc = { exitPromise: exited };

  try {
    await actor._signOutAfterExit("networkLoss");
    Assert.ok(
      actor.logoutReported,
      "The exited session is marked as logged out."
    );
    Assert.ok(
      shutdown.calledOnce,
      "Firefox shutdown is requested immediately."
    );
    Assert.ok(cancelStub.calledOnce, "An in-flight refresh is cancelled.");
    Assert.ok(clearStub.calledOnce, "Local credentials are cleared.");
    Assert.ok(
      signoutStub.calledOnceWith("captured-token", 5000),
      "Server signout is attempted with a captured token and short timeout."
    );
    Assert.ok(message.notCalled, "The notice waits for Firefox to exit.");

    finishExit();
    await TestUtils.waitForCondition(() => message.calledOnce);
    Assert.deepEqual(message.firstCall.args, [
      "FeltParent:FirefoxSessionInterrupted",
      { reason: "networkLoss", sessionLocked: false },
    ]);
  } finally {
    finishExit();
    clearStub.restore();
    signoutStub.restore();
    cancelStub.restore();
    cpmmStub.restore();
    feltStub.restore();
  }
});
