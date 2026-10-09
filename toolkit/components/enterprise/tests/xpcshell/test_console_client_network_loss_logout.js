/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const gDataHome = do_get_profile().clone();
gDataHome.append("appdata");
gDataHome.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
Services.dirsvc.set("UAppData", gDataHome);

const { ConsoleClient } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/ConsoleClient.sys.mjs"
);
const { ConsoleConnectionGuard } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/ConsoleConnectionGuard.sys.mjs"
);
const { FeltProcessParent } = ChromeUtils.importESModule(
  "chrome://felt/content/FeltProcessParent.sys.mjs"
);
const { FeltLocking } = ChromeUtils.importESModule(
  "chrome://felt/content/FeltLocking.sys.mjs"
);
const { FeltStorage } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/FeltStorage.sys.mjs"
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

const ENABLED_PREF = "enterprise.network_loss.enabled";

// Network-loss enforcement ships disabled, so the guard would never arm. These
// tests drive it directly, so turn it on for the whole file.
const enabledWasLocked = Services.prefs.prefIsLocked(ENABLED_PREF);
if (enabledWasLocked) {
  Services.prefs.unlockPref(ENABLED_PREF);
}
Services.prefs.setBoolPref(ENABLED_PREF, true);
registerCleanupFunction(() => {
  Services.prefs.clearUserPref(ENABLED_PREF);
  if (enabledWasLocked) {
    Services.prefs.lockPref(ENABLED_PREF);
  }
});

add_task(async function test_network_loss_grace_period_follows_pref_changes() {
  const pref = "enterprise.network_loss.grace_period_minutes";
  const wasLocked = Services.prefs.prefIsLocked(pref);
  const hadUserValue = Services.prefs.prefHasUserValue(pref);
  let originalGraceMinutes;
  const feltStub = sinon.stub(Services, "felt").get(() => ({
    isFeltUI: () => false,
    isFeltBrowser: () => true,
  }));
  const enforceStub = sinon.stub(ConsoleConnectionGuard, "_enforce");
  const probeStub = sinon
    .stub(ConsoleClient, "probeConsoleReachable")
    .rejects(
      new (Cu.getGlobalForObject(ConsoleClient).TypeError)(
        "ConsoleClientXHRError"
      )
    );

  try {
    if (wasLocked) {
      Services.prefs.unlockPref(pref);
    }
    if (hadUserValue) {
      originalGraceMinutes = Services.prefs.getIntPref(pref);
    }
    Services.prefs.setIntPref(pref, 1);
    ConsoleConnectionGuard.recordUnreachable();
    const originalTimer = ConsoleConnectionGuard._timer;

    ConsoleConnectionGuard._outageStartedAt -= 30000;
    Services.prefs.setIntPref(pref, 3);
    await TestUtils.waitForCondition(
      () => ConsoleConnectionGuard._timer !== originalTimer
    );
    Assert.notEqual(
      ConsoleConnectionGuard._timer,
      originalTimer,
      "Increasing the grace period replaces the pending timer."
    );
    Assert.ok(enforceStub.notCalled, "The longer grace period has not ended.");

    ConsoleConnectionGuard._outageStartedAt -= 90000;
    Services.prefs.setIntPref(pref, 1);
    await TestUtils.waitForCondition(() => enforceStub.calledOnce);
    Assert.ok(
      enforceStub.calledOnce,
      "The shorter grace period expires based on the original outage time."
    );
  } finally {
    ConsoleConnectionGuard.reset();
    if (hadUserValue) {
      Services.prefs.setIntPref(pref, originalGraceMinutes);
    } else {
      Services.prefs.clearUserPref(pref);
    }
    if (wasLocked) {
      Services.prefs.lockPref(pref);
    }
    probeStub.restore();
    enforceStub.restore();
    feltStub.restore();
  }
});

add_task(async function test_network_loss_none_action_never_ends_the_session() {
  const feltStub = sinon.stub(Services, "felt").get(() => ({
    isFeltUI: () => false,
    isFeltBrowser: () => true,
  }));

  try {
    Services.prefs.setBoolPref(ENABLED_PREF, false);
    ConsoleConnectionGuard.recordUnreachable();
    Assert.strictEqual(
      ConsoleConnectionGuard._outageStartedAt,
      null,
      "A disabled guard does not start a grace period."
    );
    Assert.strictEqual(
      ConsoleConnectionGuard._timer,
      null,
      "A disabled guard arms no timer."
    );
    Assert.strictEqual(
      await ConsoleConnectionGuard._enforce(),
      false,
      "A disabled guard cannot end the session."
    );

    Services.prefs.setBoolPref(ENABLED_PREF, true);
    ConsoleConnectionGuard.recordUnreachable();
    Assert.notStrictEqual(
      ConsoleConnectionGuard._outageStartedAt,
      null,
      "Re-enabling the guard lets the next failure start a grace period."
    );

    Services.prefs.setBoolPref(ENABLED_PREF, false);
    Assert.strictEqual(
      ConsoleConnectionGuard._outageStartedAt,
      null,
      "Disabling the guard mid-outage abandons the grace period."
    );
    Assert.strictEqual(
      ConsoleConnectionGuard._timer,
      null,
      "Disabling the guard mid-outage disarms the timer."
    );
  } finally {
    ConsoleConnectionGuard.reset();
    Services.prefs.setBoolPref(ENABLED_PREF, true);
    feltStub.restore();
  }
});

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
  const endSessionStub = sinon.stub(FeltStorage, "endSession").resolves();
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
      endSessionStub.calledOnce && clearStub.calledBefore(endSessionStub),
      "The active-session marker is cleared after credentials."
    );
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
    endSessionStub.restore();
    clearStub.restore();
    signoutStub.restore();
    cancelStub.restore();
    cpmmStub.restore();
    feltStub.restore();
  }
});

async function withExpiredOutage(task) {
  const sandbox = sinon.createSandbox();
  sandbox.stub(Services, "felt").get(() => ({
    isFeltUI: () => false,
    isFeltBrowser: () => true,
  }));
  const enforce = sandbox
    .stub(ConsoleConnectionGuard, "_enforce")
    .resolves(true);
  ConsoleConnectionGuard.reset();
  ConsoleConnectionGuard.recordUnreachable();
  ConsoleConnectionGuard._outageStartedAt -=
    ConsoleConnectionGuard._remainingGraceMs() + 1000;
  try {
    await task(sandbox, enforce);
  } finally {
    ConsoleConnectionGuard.reset();
    sandbox.restore();
  }
}

add_task(async function test_final_probe_recovery_and_transport_failure() {
  for (const result of [
    null,
    "ConsoleClientXHRError",
    "NS_ERROR_NET_TIMEOUT",
    "setup error",
  ]) {
    await withExpiredOutage(async (sandbox, enforce) => {
      const probe = sandbox.stub(ConsoleClient, "probeConsoleReachable");
      if (result) {
        probe.rejects(
          new (Cu.getGlobalForObject(ConsoleClient).TypeError)(result)
        );
      } else {
        probe.resolves();
      }
      await ConsoleConnectionGuard._verifyBeforeEnforcing();
      Assert.equal(probe.callCount, 1);
      Assert.equal(probe.firstCall.args[0].timeoutMs, 5000);
      Assert.equal(
        enforce.calledOnce,
        result === "ConsoleClientXHRError" || result === "NS_ERROR_NET_TIMEOUT"
      );
      if (!result) {
        Assert.equal(ConsoleConnectionGuard._outageStartedAt, null);
        Assert.equal(ConsoleConnectionGuard._timer, null);
      } else if (result === "setup error") {
        Assert.notEqual(
          ConsoleConnectionGuard._timer,
          null,
          "Local errors schedule another verification"
        );
      }
    });
  }
});

add_task(async function test_pending_probe_is_invalidated() {
  for (const invalidate of ["recovery", "reset", "policy"]) {
    await withExpiredOutage(async (sandbox, enforce) => {
      const pending = Promise.withResolvers();
      const probe = sandbox
        .stub(ConsoleClient, "probeConsoleReachable")
        .returns(pending.promise);
      const verification = ConsoleConnectionGuard._verifyBeforeEnforcing();
      const signal = probe.firstCall.args[0].signal;
      const startedAt = ConsoleConnectionGuard._outageStartedAt;
      ConsoleConnectionGuard.recordUnreachable();
      await ConsoleConnectionGuard._verifyBeforeEnforcing();
      Assert.equal(
        ConsoleConnectionGuard._outageStartedAt,
        startedAt,
        "Failures do not restart grace during verification"
      );
      Assert.equal(probe.callCount, 1, "Only one probe is in flight");
      if (invalidate === "recovery") {
        ConsoleConnectionGuard.recordReachable();
        ConsoleConnectionGuard.recordUnreachable();
      } else if (invalidate === "reset") {
        ConsoleConnectionGuard.reset();
      } else {
        sandbox
          .stub(ConsoleConnectionGuard, "_remainingGraceMs")
          .returns(60_000);
        ConsoleConnectionGuard.observe(
          null,
          "nsPref:changed",
          "enterprise.network_loss.grace_period_minutes"
        );
      }
      Assert.ok(signal.aborted, `${invalidate} cancels the probe`);
      pending.reject(
        new (Cu.getGlobalForObject(ConsoleClient).TypeError)(
          "ConsoleClientXHRError"
        )
      );
      await verification;
      Assert.ok(enforce.notCalled, "The stale failure cannot end the session");
      if (invalidate !== "reset") {
        Assert.notEqual(
          ConsoleConnectionGuard._timer,
          null,
          "The new grace timer remains armed"
        );
      }
    });
  }
});

add_task(async function test_probe_requires_a_fresh_http_response() {
  const server = new HttpServer();
  let requests = 0;
  server.registerPathHandler("/", (_, response) => {
    requests++;
    response.setHeader("Cache-Control", "max-age=3600", false);
    response.write("reachable");
  });
  server.start(-1);
  try {
    await withExpiredOutage(async (sandbox, enforce) => {
      sandbox
        .stub(ConsoleClient, "constructURI")
        .resolves(`http://localhost:${server.identity.primaryPort}/`);
      await ConsoleClient.probeConsoleReachable();
      await ConsoleClient.probeConsoleReachable();
      Assert.equal(
        requests,
        2,
        "The no-argument SSO probe bypasses cached responses"
      );
      ConsoleConnectionGuard.recordUnreachable();
      ConsoleConnectionGuard._outageStartedAt -=
        ConsoleConnectionGuard._remainingGraceMs() + 1000;
      server.registerPathHandler("/", (_, response) => {
        response.setStatusLine(null, 503, "Unavailable");
      });
      await ConsoleConnectionGuard._verifyBeforeEnforcing();
      Assert.ok(enforce.notCalled, "An HTTP error still proves reachability");
      Assert.equal(ConsoleConnectionGuard._outageStartedAt, null);
    });
  } finally {
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(async function test_probe_timeout_and_cancellation() {
  const server = new HttpServer();
  let finishResponse;
  let started;
  server.registerPathHandler("/", (_, response) => {
    response.processAsync();
    finishResponse = () => response.finish();
    started.resolve();
  });
  server.start(-1);
  try {
    await withExpiredOutage(async (sandbox, enforce) => {
      sandbox
        .stub(ConsoleClient, "constructURI")
        .resolves(`http://localhost:${server.identity.primaryPort}/`);
      started = Promise.withResolvers();
      const controller = new AbortController();
      const probe = ConsoleClient.probeConsoleReachable({
        signal: controller.signal,
      });
      const cancellation = started.promise.then(() => controller.abort());
      await Assert.rejects(probe, /Request cancelled/);
      await cancellation;
      Assert.ok(enforce.notCalled);
      finishResponse();
      started = Promise.withResolvers();
      await ConsoleConnectionGuard._verifyBeforeEnforcing();
      Assert.ok(
        enforce.calledOnce,
        "A stalled final request times out and enforces"
      );
      finishResponse();
    });
  } finally {
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(async function test_cached_console_responses_do_not_clear_outage() {
  for (const binary of [false, true]) {
    const server = new HttpServer();
    let requests = 0;
    server.registerPathHandler("/", (_, response) => {
      requests++;
      response.setHeader("Cache-Control", "max-age=3600", false);
      response.write('{"reachable":true}');
    });
    server.start(-1);
    let stopped = false;
    try {
      await withExpiredOutage(async (sandbox, enforce) => {
        sandbox.stub(ConsoleClient, "getAccessToken").resolves("token");
        sandbox
          .stub(ConsoleClient, "constructURI")
          .resolves(`http://localhost:${server.identity.primaryPort}/`);
        const request = () =>
          binary
            ? ConsoleClient._fetchBinary("/")
            : ConsoleClient._fetch("/", "GET");
        await request();
        Assert.equal(
          ConsoleConnectionGuard._outageStartedAt,
          null,
          "A network response clears the outage"
        );
        await new Promise(resolve => server.stop(resolve));
        stopped = true;
        ConsoleConnectionGuard.recordUnreachable();
        const startedAt = ConsoleConnectionGuard._outageStartedAt;
        const timer = ConsoleConnectionGuard._timer;
        await request();
        await request();
        Assert.equal(
          requests,
          1,
          "Ordinary requests reuse the cached response"
        );
        Assert.equal(ConsoleConnectionGuard._outageStartedAt, startedAt);
        Assert.equal(
          ConsoleConnectionGuard._timer,
          timer,
          "Cache hits leave the outage timer armed"
        );
        ConsoleConnectionGuard._outageStartedAt -=
          ConsoleConnectionGuard._remainingGraceMs() + 1000;
        await ConsoleConnectionGuard._verifyBeforeEnforcing();
        Assert.ok(
          enforce.calledOnce,
          "The uncached final probe still enforces"
        );
      });
    } finally {
      if (!stopped) {
        await new Promise(resolve => server.stop(resolve));
      }
    }
  }
});

add_task(async function test_revalidated_console_response_clears_outage() {
  const server = new HttpServer();
  let requests = 0;
  server.registerPathHandler("/", (request, response) => {
    requests++;
    response.setHeader("Cache-Control", "no-cache", false);
    response.setHeader("ETag", '"console-response"', false);
    if (requests > 1) {
      Assert.equal(request.getHeader("If-None-Match"), '"console-response"');
      response.setStatusLine(null, 304, "Not Modified");
    } else {
      response.write('{"reachable":true}');
    }
  });
  server.start(-1);
  try {
    await withExpiredOutage(async (sandbox, enforce) => {
      sandbox.stub(ConsoleClient, "getAccessToken").resolves("token");
      sandbox
        .stub(ConsoleClient, "constructURI")
        .resolves(`http://localhost:${server.identity.primaryPort}/`);
      await ConsoleClient._fetch("/", "GET");
      ConsoleConnectionGuard.recordUnreachable();
      Assert.deepEqual(await ConsoleClient._fetch("/", "GET"), {
        reachable: true,
      });
      Assert.equal(
        requests,
        2,
        "The cached response was revalidated over the network"
      );
      Assert.equal(ConsoleConnectionGuard._outageStartedAt, null);
      Assert.equal(ConsoleConnectionGuard._timer, null);
      Assert.ok(enforce.notCalled);
    });
  } finally {
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
  const unreachable = sandbox.stub(ConsoleConnectionGuard, "recordUnreachable");
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
    Assert.ok(unreachable.calledOnce);

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
    Assert.ok(
      unreachable.calledOnce,
      "Stale failures do not start another outage"
    );
    reply(current);
    await second;
    Assert.ok(setTokens.calledOnceWith(`token-${current.id}`, "", 4102444800));
    Assert.equal(ConsoleClient._refreshRequest, null);

    const failed = ConsoleClient._refreshSession();
    const failedRequest = ConsoleClient._refreshRequest;
    reply(failedRequest, "ConsoleClientXHRError");
    await Assert.rejects(failed, /ConsoleClientXHRError/);
    Assert.equal(ConsoleClient._refreshRequest, null, "Failure allows a retry");
    Assert.equal(unreachable.callCount, 2);

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
    "resource://gre/modules/enterprise/ForcedQuitHandler.sys.mjs"
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
