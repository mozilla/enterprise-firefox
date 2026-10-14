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
const { ConsoleConnectionGuard } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/enterprise/modules/ConsoleConnectionGuard.sys.mjs"
);
const { FeltProcessParent } = ChromeUtils.importESModule(
  "chrome://felt/content/FeltProcessParent.sys.mjs"
);
const { FeltLocking } = ChromeUtils.importESModule(
  "chrome://felt/content/FeltLocking.sys.mjs"
);
const { ForcedQuitHandler } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/enterprise/modules/ForcedQuitHandler.sys.mjs"
);
const { FeltStorage } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/felt/FeltStorage.sys.mjs"
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

// Ending the session really quits, so keep every test from reaching it unless
// it drives the stub or calls the wrapped method with the quit stubbed.
const gEndSession = sinon
  .stub(ConsoleConnectionGuard, "_endSession")
  .resolves(false);
registerCleanupFunction(() => gEndSession.restore());

// Built in ConsoleClient's global so its instanceof checks recognize it.
const transportError = message =>
  new (Cu.getGlobalForObject(ConsoleClient).TypeError)(message);

function stubFeltBrowser(sandbox) {
  sandbox.stub(Services, "felt").get(() => ({
    isFeltUI: () => false,
    isFeltBrowser: () => true,
  }));
}

// Runs `task` with ConsoleClient pointed at a local server handling "/".
async function withConsoleServer(handler, task) {
  const server = new HttpServer();
  server.registerPathHandler("/", handler);
  server.start(-1);
  const stub = sinon
    .stub(ConsoleClient, "constructURI")
    .resolves(`http://localhost:${server.identity.primaryPort}/`);
  try {
    await task(server);
  } finally {
    stub.restore();
    if (!server.isStopped()) {
      await new Promise(resolve => server.stop(resolve));
    }
  }
}

add_task(async function test_deadline_failure_needs_confirmation() {
  const CONFIRMATION_MS = 2 * 60 * 1000;
  const sandbox = sinon.createSandbox();
  stubFeltBrowser(sandbox);
  const enforce = sandbox.stub(ConsoleConnectionGuard, "_enforce").resolves();
  const probe = sandbox
    .stub(ConsoleClient, "probeConsoleReachable")
    .rejects(transportError("ConsoleClientXHRError"));
  const pastDeadline = () => {
    ConsoleConnectionGuard._outageStartedAt = Date.now() - 24 * 60 * 60 * 1000;
  };
  try {
    ConsoleConnectionGuard.recordUnreachable();
    pastDeadline();
    await ConsoleConnectionGuard._verifyBeforeEnforcing();
    Assert.ok(enforce.notCalled, "One failed deadline probe does not enforce.");
    Assert.notEqual(ConsoleConnectionGuard._firstFailedProbeAt, null);
    Assert.notEqual(
      ConsoleConnectionGuard._timer,
      null,
      "A confirming probe is scheduled."
    );

    ConsoleConnectionGuard._firstFailedProbeAt -= 3 * CONFIRMATION_MS;
    const sleptAt = ConsoleConnectionGuard._firstFailedProbeAt;
    await ConsoleConnectionGuard._verifyBeforeEnforcing();
    Assert.ok(
      enforce.notCalled,
      "A confirmation that slept through its wait starts the wait over."
    );
    Assert.greater(ConsoleConnectionGuard._firstFailedProbeAt, sleptAt);

    ConsoleConnectionGuard._firstFailedProbeAt -= CONFIRMATION_MS;
    await ConsoleConnectionGuard._verifyBeforeEnforcing();
    Assert.ok(enforce.calledOnce, "A second failure on time enforces.");

    enforce.resetHistory();
    ConsoleConnectionGuard.reset();
    ConsoleConnectionGuard.recordUnreachable();
    pastDeadline();
    await ConsoleConnectionGuard._verifyBeforeEnforcing();
    probe.resolves();
    ConsoleConnectionGuard._firstFailedProbeAt -= CONFIRMATION_MS;
    await ConsoleConnectionGuard._verifyBeforeEnforcing();
    Assert.ok(enforce.notCalled, "A console that answers in time recovers.");
    Assert.equal(ConsoleConnectionGuard._outageStartedAt, null);
    Assert.equal(ConsoleConnectionGuard._firstFailedProbeAt, null);
  } finally {
    ConsoleConnectionGuard.reset();
    sandbox.restore();
  }
});

add_task(async function test_network_loss_none_action_never_ends_the_session() {
  const sandbox = sinon.createSandbox();
  stubFeltBrowser(sandbox);

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
      await ConsoleConnectionGuard._enforce(),
      false,
      "Disabling the guard mid-outage keeps the deadline from ending the session."
    );
    Assert.strictEqual(
      ConsoleConnectionGuard._outageStartedAt,
      null,
      "The deadline abandons the grace period."
    );
    Assert.strictEqual(
      ConsoleConnectionGuard._timer,
      null,
      "The deadline disarms the timer."
    );
  } finally {
    ConsoleConnectionGuard.reset();
    Services.prefs.setBoolPref(ENABLED_PREF, true);
    sandbox.restore();
  }
});

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

add_task(async function test_network_loss_logout_does_not_wait_for_server() {
  const sandbox = sinon.createSandbox();
  const { promise: exited, resolve: finishExit } = Promise.withResolvers();
  const shutdown = sandbox.stub();
  sandbox.stub(Services, "felt").get(() => ({
    shutdownFirefox: shutdown,
    getAccessTokenIfValid: () => "captured-token",
  }));
  const message = sandbox.stub();
  sandbox.stub(Services, "cpmm").get(() => ({ sendAsyncMessage: message }));
  const cancelStub = sandbox.stub(ConsoleClient, "cancelPendingRefresh");
  const signoutStub = sandbox
    .stub(ConsoleClient, "performServerSignoutWithToken")
    .returns(new Promise(() => {}));
  const clearStub = sandbox.stub(FeltLocking, "clearLockAndTokens");
  const endSessionStub = sandbox.stub(FeltStorage, "endSession").resolves();
  const actor = Object.create(FeltProcessParent.prototype);
  actor.proc = { exitPromise: exited };

  try {
    await actor._logoutAfterNetworkLoss();
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
    sandbox.restore();
  }
});

add_task(async function test_network_loss_enforcement_ends_the_session() {
  const sandbox = sinon.createSandbox();
  stubFeltBrowser(sandbox);
  ConsoleConnectionGuard.reset();
  gEndSession.resetHistory();
  try {
    gEndSession.rejects(new Error("could not end the session"));
    ConsoleConnectionGuard.recordUnreachable();
    Assert.strictEqual(
      await ConsoleConnectionGuard._enforce(),
      false,
      "A failed session end is reported as not ended."
    );
    Assert.notStrictEqual(
      ConsoleConnectionGuard._timer,
      null,
      "A failed session end is retried."
    );

    gEndSession.resolves(true);
    Assert.strictEqual(
      await ConsoleConnectionGuard._enforce(),
      true,
      "The session is ended."
    );
    Assert.ok(
      gEndSession.alwaysCalledWithExactly(false),
      "The session is signed out, as the locking pref defaults to."
    );

    ConsoleConnectionGuard.recordUnreachable();
    Assert.strictEqual(
      ConsoleConnectionGuard._outageStartedAt,
      null,
      "An ended session starts no new grace period."
    );
  } finally {
    ConsoleConnectionGuard.reset();
    gEndSession.reset();
    gEndSession.resolves(false);
    sandbox.restore();
  }
});

add_task(async function test_network_loss_recovery_during_enforcement() {
  // Enforcement starts only after the deadline probe found the console gone,
  // so a success reported while it runs must not cancel the retry a failed
  // attempt needs.
  const sandbox = sinon.createSandbox();
  stubFeltBrowser(sandbox);
  ConsoleConnectionGuard.reset();
  const attempt = Promise.withResolvers();
  gEndSession.reset();
  gEndSession.returns(attempt.promise);
  try {
    ConsoleConnectionGuard.recordUnreachable();
    const enforcing = ConsoleConnectionGuard._enforce();
    ConsoleConnectionGuard.recordReachable();
    Assert.notStrictEqual(
      ConsoleConnectionGuard._outageStartedAt,
      null,
      "The outage stands while the session is being ended."
    );

    attempt.resolve(false);
    Assert.strictEqual(await enforcing, false);
    Assert.notStrictEqual(
      ConsoleConnectionGuard._timer,
      null,
      "The failed attempt is retried."
    );

    ConsoleConnectionGuard.recordReachable();
    Assert.strictEqual(
      ConsoleConnectionGuard._outageStartedAt,
      null,
      "Once enforcement settles, recovery clears the outage."
    );
  } finally {
    attempt.resolve(false);
    ConsoleConnectionGuard.reset();
    gEndSession.reset();
    gEndSession.resolves(false);
    sandbox.restore();
  }
});

add_task(async function test_network_loss_end_session_paths() {
  const endSession = lock =>
    gEndSession.wrappedMethod.call(ConsoleConnectionGuard, lock);
  const SIGNOUT = [false, "networkLoss"];
  const LOCK = [true, "networkLoss"];
  for (const [lock, quitStartsShutdown, signoutThrows, ended, intents] of [
    [false, false, false, true, [SIGNOUT]],
    [true, true, false, true, [LOCK]],
    [true, false, false, true, [LOCK, SIGNOUT]],
    [false, true, true, true, [SIGNOUT, SIGNOUT]],
    [false, false, true, false, [SIGNOUT, SIGNOUT]],
  ]) {
    info(
      `lock=${lock} quitStartsShutdown=${quitStartsShutdown} signoutThrows=${signoutThrows}`
    );
    const sandbox = sinon.createSandbox();
    const setShutdownLockIntent = sandbox.stub();
    const performSignoutWithReason = sandbox.stub();
    if (signoutThrows) {
      performSignoutWithReason.throws(new Error("no FELT client"));
    }
    sandbox.stub(Services, "felt").get(() => ({
      isFeltBrowser: () => true,
      setShutdownLockIntent,
      performSignoutWithReason,
    }));
    const startup = { shuttingDown: false };
    sandbox.stub(Services, "startup").get(() => startup);
    const quit = sandbox
      .stub(ForcedQuitHandler, "quitIgnoringCanClose")
      .callsFake(async () => {
        startup.shuttingDown = quitStartsShutdown;
      });
    try {
      Assert.strictEqual(await endSession(lock), ended);
      Assert.ok(quit.called, "Every path quits the browser itself.");
      Assert.deepEqual(
        setShutdownLockIntent.args,
        intents,
        "The exit carries the NetworkLoss intent."
      );
      if (quit.called) {
        Assert.ok(
          setShutdownLockIntent.calledBefore(quit),
          "The intent is declared before the quit it rides out on."
        );
      }
      Assert.equal(
        performSignoutWithReason.called,
        !(lock && quitStartsShutdown),
        "Only a lock that starts shutdown skips the signout."
      );
      if (performSignoutWithReason.called) {
        Assert.ok(performSignoutWithReason.calledWithExactly("networkLoss"));
      }
    } finally {
      sandbox.restore();
    }
  }
});

// Once the access token expires, the browser's console requests wait on FELT's
// refresh, so FELT failing to reach the console must start the grace period.
add_task(async function test_felt_refresh_transport_failure_starts_outage() {
  const sandbox = sinon.createSandbox();
  stubFeltBrowser(sandbox);
  sandbox.stub(ConsoleClient, "_syncCrashReporterAuthToken");
  const reply = error =>
    ConsoleClient.observe(
      null,
      "felt-firefox-token-refresh-result",
      JSON.stringify({ request_id: 0, error })
    );
  ConsoleConnectionGuard.reset();
  try {
    reply("Token refresh failed");
    Assert.strictEqual(
      ConsoleConnectionGuard._outageStartedAt,
      null,
      "A console that refused the refresh was reachable."
    );
    reply("NS_ERROR_NET_TIMEOUT");
    Assert.notStrictEqual(
      ConsoleConnectionGuard._outageStartedAt,
      null,
      "A refresh FELT could not send starts the grace period."
    );
  } finally {
    ConsoleConnectionGuard.reset();
    sandbox.restore();
  }
});

async function withExpiredOutage(task) {
  const sandbox = sinon.createSandbox();
  stubFeltBrowser(sandbox);
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

add_task(async function test_failure_after_missed_deadline_verifies() {
  await withExpiredOutage(async sandbox => {
    const verify = sandbox.stub(
      ConsoleConnectionGuard,
      "_verifyBeforeEnforcing"
    );
    ConsoleConnectionGuard.recordUnreachable();
    Assert.ok(
      verify.calledOnce,
      "A failure after a deadline the timer slept through verifies the outage."
    );

    ConsoleConnectionGuard._firstFailedProbeAt = Date.now();
    ConsoleConnectionGuard.recordUnreachable();
    Assert.ok(verify.calledOnce, "A pending confirmation is not cut short.");

    ConsoleConnectionGuard._firstFailedProbeAt = null;
    ConsoleConnectionGuard._outageStartedAt = Date.now();
    ConsoleConnectionGuard.recordUnreachable();
    Assert.ok(verify.calledOnce, "A failure within the grace period waits.");
  });
});

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
        probe.rejects(transportError(result));
      } else {
        probe.resolves();
      }
      await ConsoleConnectionGuard._verifyBeforeEnforcing();
      Assert.equal(probe.callCount, 1);
      Assert.equal(probe.firstCall.args[0].timeoutMs, 5000);
      Assert.ok(enforce.notCalled, "One probe never enforces on its own.");
      const transportFailure =
        result === "ConsoleClientXHRError" || result === "NS_ERROR_NET_TIMEOUT";
      if (transportFailure) {
        ConsoleConnectionGuard._firstFailedProbeAt -= 2 * 60 * 1000;
        await ConsoleConnectionGuard._verifyBeforeEnforcing();
        Assert.ok(enforce.calledOnce, "The confirming failure enforces.");
      }
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
  for (const invalidate of ["recovery", "reset"]) {
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
      } else {
        ConsoleConnectionGuard.reset();
      }
      Assert.ok(signal.aborted, `${invalidate} cancels the probe`);
      pending.reject(transportError("ConsoleClientXHRError"));
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
  let requests = 0;
  const cached = (_, response) => {
    requests++;
    response.setHeader("Cache-Control", "max-age=3600", false);
    response.write("reachable");
  };
  await withConsoleServer(cached, async server => {
    await withExpiredOutage(async (sandbox, enforce) => {
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
  });
});

add_task(async function test_probe_timeout_and_cancellation() {
  let finishResponse;
  let started;
  const stalled = (_, response) => {
    response.processAsync();
    finishResponse = () => response.finish();
    started.resolve();
  };
  await withConsoleServer(stalled, async () => {
    await withExpiredOutage(async (sandbox, enforce) => {
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
      Assert.notEqual(
        ConsoleConnectionGuard._firstFailedProbeAt,
        null,
        "A stalled final request times out as a network failure"
      );
      Assert.ok(enforce.notCalled, "It waits for a confirming probe");
      finishResponse();
    });
  });
});

add_task(async function test_cached_console_responses_do_not_clear_outage() {
  let requests = 0;
  const cached = (_, response) => {
    requests++;
    response.setHeader("Cache-Control", "max-age=3600", false);
    response.write('{"reachable":true}');
  };
  await withConsoleServer(cached, async server => {
    await withExpiredOutage(async (sandbox, enforce) => {
      sandbox.stub(ConsoleClient, "getAccessToken").resolves("token");
      await ConsoleClient._fetch("/", "GET");
      Assert.equal(
        ConsoleConnectionGuard._outageStartedAt,
        null,
        "A network response clears the outage"
      );
      await new Promise(resolve => server.stop(resolve));
      ConsoleConnectionGuard.recordUnreachable();
      const startedAt = ConsoleConnectionGuard._outageStartedAt;
      const timer = ConsoleConnectionGuard._timer;
      await ConsoleClient._fetch("/", "GET");
      await ConsoleClient._fetch("/", "GET");
      Assert.equal(requests, 1, "Ordinary requests reuse the cached response");
      Assert.equal(ConsoleConnectionGuard._outageStartedAt, startedAt);
      Assert.equal(
        ConsoleConnectionGuard._timer,
        timer,
        "Cache hits leave the outage timer armed"
      );
      ConsoleConnectionGuard._outageStartedAt -=
        ConsoleConnectionGuard._remainingGraceMs() + 1000;
      await ConsoleConnectionGuard._verifyBeforeEnforcing();
      ConsoleConnectionGuard._firstFailedProbeAt -= 2 * 60 * 1000;
      await ConsoleConnectionGuard._verifyBeforeEnforcing();
      Assert.ok(enforce.calledOnce, "The uncached final probes still enforce");
    });
  });
});

add_task(async function test_revalidated_console_response_clears_outage() {
  let requests = 0;
  const revalidated = (request, response) => {
    requests++;
    response.setHeader("Cache-Control", "no-cache", false);
    response.setHeader("ETag", '"console-response"', false);
    if (requests > 1) {
      Assert.equal(request.getHeader("If-None-Match"), '"console-response"');
      response.setStatusLine(null, 304, "Not Modified");
    } else {
      response.write('{"reachable":true}');
    }
  };
  await withConsoleServer(revalidated, async () => {
    await withExpiredOutage(async (sandbox, enforce) => {
      sandbox.stub(ConsoleClient, "getAccessToken").resolves("token");
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
  });
});

add_task(async function test_browser_refresh_results_are_correlated() {
  const sandbox = sinon.createSandbox();
  const send = sandbox.stub();
  sandbox.stub(Services, "felt").get(() => ({
    isFeltBrowser: () => true,
    refreshTokens: send,
  }));
  const sync = sandbox.stub(ConsoleClient, "_syncCrashReporterAuthToken");
  sandbox
    .stub(ConsoleClient, "probeConsoleReachable")
    .rejects(transportError("ConsoleClientXHRError"));
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
    ConsoleConnectionGuard.reset();
    sandbox.restore();
  }
});

add_task(async function test_unanswered_refresh_without_network_loss() {
  // Without the NetworkLoss policy, a refresh FELT never answers ends the
  // session, as it did before the policy existed.
  const sandbox = sinon.createSandbox();
  const send = sandbox.stub();
  const performSignout = sandbox.stub();
  sandbox.stub(Services, "felt").get(() => ({
    isFeltBrowser: () => true,
    refreshTokens: send,
    performSignout,
  }));
  const quit = sandbox.stub(ForcedQuitHandler, "quitIgnoringCanClose");
  const probe = sandbox
    .stub(ConsoleClient, "probeConsoleReachable")
    .rejects(transportError("ConsoleClientXHRError"));
  try {
    const enforced = ConsoleClient._refreshSession();
    const enforcedRequest = ConsoleClient._refreshRequest;
    Assert.ok(
      send.calledOnceWith(enforcedRequest.id, true),
      "FELT is told the NetworkLoss policy handles network failures."
    );
    ConsoleClient._onBrowserRefreshTimeout(enforcedRequest);
    await Assert.rejects(enforced, /NS_ERROR_NET_TIMEOUT/);
    Assert.ok(probe.calledOnce, "The browser checks the console itself.");
    Assert.ok(performSignout.notCalled, "The grace period decides instead.");

    const pendingProbe = Promise.withResolvers();
    probe.returns(pendingProbe.promise);
    const answered = ConsoleClient._refreshSession();
    const answeredRequest = ConsoleClient._refreshRequest;
    const timedOut = ConsoleClient._onBrowserRefreshTimeout(answeredRequest);
    ConsoleClient.observe(
      null,
      "felt-firefox-token-refresh-result",
      JSON.stringify({
        request_id: answeredRequest.id,
        error: "ConsoleClientXHRError",
      })
    );
    await Assert.rejects(answered, /ConsoleClientXHRError/);
    pendingProbe.resolve();
    await timedOut;
    Assert.ok(
      performSignout.notCalled,
      "A FELT reply during the probe keeps the session."
    );

    probe.resolves();
    const unresponsive = ConsoleClient._refreshSession();
    const unresponsiveRequest = ConsoleClient._refreshRequest;
    ConsoleClient._onBrowserRefreshTimeout(unresponsiveRequest);
    await Assert.rejects(unresponsive, /failed to respond/);
    Assert.ok(
      performSignout.calledOnce,
      "A reachable console means FELT is unresponsive, so the session ends."
    );
    Assert.ok(quit.calledOnce, "The browser quits.");

    probe.rejects(new Error("Console address unavailable"));
    const probeFailed = ConsoleClient._refreshSession();
    const probeFailedRequest = ConsoleClient._refreshRequest;
    ConsoleClient._onBrowserRefreshTimeout(probeFailedRequest);
    await Assert.rejects(probeFailed, /failed to respond/);
    Assert.ok(
      performSignout.calledTwice,
      "A probe that fails off the network does not start a grace period."
    );
    Assert.ok(quit.calledTwice, "The browser quits.");

    probe.resetHistory();
    Services.prefs.setBoolPref(ENABLED_PREF, false);
    const refresh = ConsoleClient._refreshSession();
    const request = ConsoleClient._refreshRequest;
    Assert.ok(
      send.getCall(4).calledWithExactly(request.id, false),
      "FELT is told to end the session on any failure."
    );
    ConsoleClient._onBrowserRefreshTimeout(request);
    await Assert.rejects(refresh, /failed to respond/);
    Assert.ok(probe.notCalled, "Without the policy the console is not probed.");
    Assert.ok(performSignout.calledThrice, "The session is signed out.");
    Assert.ok(quit.calledThrice, "The browser quits.");
  } finally {
    Services.prefs.setBoolPref(ENABLED_PREF, true);
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
