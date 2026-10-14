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
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

add_task(async function test_old_refresh_cannot_replace_new_session_refresh() {
  const sandbox = sinon.createSandbox();
  const setTokens = sandbox.stub();
  sandbox.stub(Services, "felt").get(() => ({
    isFeltUI: () => true,
    getRefreshToken: () => "refresh-token",
    setTokens,
  }));
  sandbox.stub(ConsoleClient, "_paths").get(() => ({ TOKEN: "/token" }));
  sandbox
    .stub(ConsoleClient, "constructURI")
    .resolves("https://console.example.com/token");
  const oldReply = Promise.withResolvers();
  const newReply = Promise.withResolvers();
  const xhrStub = sandbox.stub(ConsoleClient, "_xhrFetch");
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
    Assert.ok(
      xhrStub.firstCall.args[1].signal.aborted,
      "The cancelled refresh's XHR is aborted."
    );

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
      setTokens.calledOnceWith("new", "new-refresh", sinon.match.number),
      "Only the new session's reply sets tokens."
    );
  } finally {
    oldReply.resolve(reply("old"));
    newReply.resolve(reply("new"));
    await Promise.resolve(ConsoleClient._feltRefreshPromise).catch(() => {});
    sandbox.restore();
  }
});

add_task(async function test_browser_refresh_results_are_correlated() {
  const sandbox = sinon.createSandbox();
  const send = sandbox.stub();
  sandbox.stub(Services, "felt").get(() => ({
    isFeltBrowser: () => true,
    refreshTokens: send,
  }));
  const sync = sandbox.stub(ConsoleClient, "_syncCrashReporterAuthToken");
  const reply = (request, error = "") =>
    ConsoleClient.observe(
      null,
      "felt-firefox-token-refresh-result",
      JSON.stringify({ request_id: request.id, error })
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
    Assert.ok(
      sync.calledTwice,
      "A late success, like an untagged update, still syncs the stored token"
    );
    reply(current);
    await second;
    Assert.ok(sync.calledThrice);
    Assert.equal(ConsoleClient._refreshRequest, null);

    const failed = ConsoleClient._refreshSession();
    const failedRequest = ConsoleClient._refreshRequest;
    reply(failedRequest, "ConsoleClientXHRError");
    await Assert.rejects(failed, /ConsoleClientXHRError/);
    Assert.equal(ConsoleClient._refreshRequest, null, "Failure allows a retry");

    send.throws(new Error("IPC disconnected"));
    const unsent = ConsoleClient._refreshSession();
    const unsentRequest = ConsoleClient._refreshRequest;
    Assert.ok(unsentRequest, "A send failure is left to the timeout");
    ConsoleClient._onBrowserRefreshTimeout(unsentRequest);
    await Assert.rejects(unsent, /NS_ERROR_NET_TIMEOUT/);
    Assert.equal(ConsoleClient._refreshRequest, null);
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
  sandbox.stub(Services, "felt").get(() => ({
    isFeltBrowser: () => true,
    refreshTokens: sandbox.stub(),
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
      JSON.stringify({ request_id: request.id, error: "" })
    );
    Assert.equal(
      ConsoleClient._refreshRequest,
      null,
      "A late result cannot revive a request retired by shutdown"
    );
  } finally {
    ConsoleClient._refreshShuttingDown = false;
    ConsoleClient._finishBrowserRefresh(ConsoleClient._refreshRequest);
    sandbox.restore();
  }
});
