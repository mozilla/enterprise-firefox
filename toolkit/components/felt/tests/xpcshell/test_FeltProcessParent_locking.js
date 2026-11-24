/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { FeltProcessParent } = ChromeUtils.importESModule(
  "chrome://felt/content/FeltProcessParent.sys.mjs"
);
const { FeltLocking } = ChromeUtils.importESModule(
  "chrome://felt/content/FeltLocking.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

// The payload FELT receives when the browser asks for a token refresh.
function refreshRequest(requestId, networkLossEnforced = false) {
  return JSON.stringify({
    request_id: requestId,
    network_loss_enforced: networkLossEnforced,
  });
}

// An unreachable console is the browser's network-loss grace period's call, not
// FELT's; only a console that answered and refused ends the session here.
add_task(function test_refresh_failure_left_to_network_loss_policy() {
  const { ConsoleClient } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs"
  );
  const { PostureMonitor } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/enterprise/modules/DevicePosture.sys.mjs"
  );
  const { TypeError } = Cu.getGlobalForObject(ConsoleClient);
  const cases = [
    {
      error: new TypeError("ConsoleClientXHRError"),
      networkLossEnforced: true,
      ends: false,
      label: "A network failure is left to the NetworkLoss grace period.",
    },
    {
      error: new TypeError("NS_ERROR_NET_TIMEOUT"),
      networkLossEnforced: true,
      ends: false,
      label: "A timeout is left to the NetworkLoss grace period.",
    },
    {
      error: new Error("Token refresh failed: , Status: 500"),
      networkLossEnforced: true,
      ends: true,
      label: "A refused refresh ends the session even under NetworkLoss.",
    },
    {
      error: new TypeError("ConsoleClientXHRError"),
      networkLossEnforced: false,
      ends: true,
      label: "Without NetworkLoss, a network failure ends the session.",
    },
  ];
  for (const { error, networkLossEnforced, ends, label } of cases) {
    const sandbox = sinon.createSandbox();
    const shutdownFirefox = sandbox.stub();
    const clearLockAndTokens = sandbox.stub(FeltLocking, "clearLockAndTokens");
    sandbox.stub(PostureMonitor, "stop");
    sandbox.stub(Services, "felt").get(() => ({ shutdownFirefox }));
    const actor = new FeltProcessParent();
    actor.proc = { exitPromise: new Promise(() => {}) };
    try {
      actor.endSessionAfterRefreshFailure(error, networkLossEnforced);
      Assert.equal(shutdownFirefox.called, ends, label);
      Assert.equal(
        clearLockAndTokens.called,
        ends,
        "The credentials are dropped only when the session ends."
      );
      Assert.equal(!!actor.logoutReported, ends);
    } finally {
      sandbox.restore();
    }
  }
});

add_task(async function test_browser_refresh_replies_echo_request_ids() {
  const { ConsoleClient } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs"
  );
  const { PostureMonitor } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/enterprise/modules/DevicePosture.sys.mjs"
  );
  const { TestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/TestUtils.sys.mjs"
  );
  const sandbox = sinon.createSandbox();
  const complete = sandbox.stub();
  sandbox
    .stub(Services, "felt")
    .get(() => ({ completeTokenRefresh: complete }));
  sandbox.stub(PostureMonitor, "postureForRefresh").resolves({ posture: null });
  sandbox.stub(FeltLocking, "updateStoredToken").resolves();
  const refresh = sandbox.stub(ConsoleClient, "refreshTokens");
  const actor = new FeltProcessParent();
  sandbox.stub(actor, "_storeEdrAgents");
  const failed = sandbox.stub(actor, "endSessionAfterRefreshFailure");
  const old = Promise.withResolvers();
  const current = Promise.withResolvers();
  refresh.onFirstCall().returns(old.promise);
  refresh.onSecondCall().returns(current.promise);
  try {
    actor.browserObserver.observe(
      null,
      "felt-firefox-refresh-tokens",
      refreshRequest(10)
    );
    actor.browserObserver.observe(
      null,
      "felt-firefox-refresh-tokens",
      refreshRequest(11)
    );
    await TestUtils.waitForCondition(() => refresh.calledOnce);
    old.resolve({ refresh_token: "old" });
    await TestUtils.waitForCondition(() => refresh.calledTwice);
    Assert.deepEqual(complete.firstCall.args, [10, ""]);
    current.resolve({ refresh_token: "current" });
    await TestUtils.waitForCondition(() => complete.calledTwice);
    Assert.deepEqual(complete.secondCall.args, [11, ""]);

    refresh.rejects(
      new (Cu.getGlobalForObject(ConsoleClient).TypeError)(
        "ConsoleClientXHRError"
      )
    );
    actor.browserObserver.observe(
      null,
      "felt-firefox-refresh-tokens",
      refreshRequest(12, true)
    );
    await TestUtils.waitForCondition(() => failed.calledOnce);
    Assert.deepEqual(complete.thirdCall.args, [12, "ConsoleClientXHRError"]);
  } finally {
    old.resolve({ refresh_token: "old" });
    current.resolve({ refresh_token: "current" });
    await actor._drainPendingRefresh();
    sandbox.restore();
  }
});

add_task(async function test_cancelled_browser_refresh_keeps_session() {
  // A new sign-in cancels any refresh still in flight; that cancellation is
  // not a refresh failure and must not tear the session down.
  const { ConsoleClient } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs"
  );
  const { PostureMonitor } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/enterprise/modules/DevicePosture.sys.mjs"
  );
  const { TestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/TestUtils.sys.mjs"
  );
  const sandbox = sinon.createSandbox();
  const complete = sandbox.stub();
  sandbox
    .stub(Services, "felt")
    .get(() => ({ completeTokenRefresh: complete }));
  sandbox.stub(PostureMonitor, "postureForRefresh").resolves({ posture: null });
  const refresh = sandbox
    .stub(ConsoleClient, "refreshTokens")
    .rejects(new DOMException("Refresh cancelled", "AbortError"));
  const actor = new FeltProcessParent();
  const failed = sandbox.stub(actor, "endSessionAfterRefreshFailure");
  try {
    actor.browserObserver.observe(
      null,
      "felt-firefox-refresh-tokens",
      refreshRequest(20)
    );
    await TestUtils.waitForCondition(() => refresh.calledOnce);
    await actor._drainPendingRefresh();
    Assert.ok(failed.notCalled, "A cancelled refresh does not end the session");
    Assert.ok(
      complete.notCalled,
      "A cancelled refresh is not reported as a failure"
    );
  } finally {
    await actor._drainPendingRefresh();
    sandbox.restore();
  }
});

add_task(async function test_refresh_persistence_survives_queue_and_teardown() {
  const { ConsoleClient } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs"
  );
  const { ConsoleConnectionGuard } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/enterprise/modules/ConsoleConnectionGuard.sys.mjs"
  );
  const { PostureMonitor } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/enterprise/modules/DevicePosture.sys.mjs"
  );
  const { FeltStorage } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/felt/FeltStorage.sys.mjs"
  );
  const { OSKeyStore } = ChromeUtils.importESModule(
    "resource://gre/modules/OSKeyStore.sys.mjs"
  );
  const { TestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/TestUtils.sys.mjs"
  );
  await FeltStorage.init();
  const email = "refresh-queue@example.com";
  FeltStorage.updateLastSignedInUserEmail(email);
  for (const mode of ["queue", "drain", "keystore-failure"]) {
    const sandbox = sinon.createSandbox();
    const encryption = Promise.withResolvers();
    let currentToken;
    let drain;
    const actor = new FeltProcessParent();
    const setTokens = sandbox.stub();
    // Stands in for the browser's FELT client thread, which stores the token
    // before notifying.
    const complete = sandbox.stub().callsFake((requestId, error) => {
      if (!error) {
        setTokens(currentToken, "", 4102444800);
      }
      ConsoleClient.observe(
        null,
        "felt-firefox-token-refresh-result",
        JSON.stringify({ request_id: requestId, error })
      );
    });
    sandbox.stub(Services, "felt").get(() => ({
      isFeltBrowser: () => true,
      refreshTokens: (requestId, networkLossEnforced) =>
        actor.browserObserver.observe(
          null,
          "felt-firefox-refresh-tokens",
          refreshRequest(requestId, networkLossEnforced)
        ),
      completeTokenRefresh: complete,
      setTokens,
    }));
    sandbox.stub(ConsoleClient, "_syncCrashReporterAuthToken");
    sandbox.stub(ConsoleConnectionGuard, "recordUnreachable");
    sandbox
      .stub(PostureMonitor, "postureForRefresh")
      .resolves({ posture: null });
    sandbox.stub(actor, "_storeEdrAgents");
    const failed = sandbox.stub(actor, "endSessionAfterRefreshFailure");
    let refreshes = 0;
    const refresh = sandbox
      .stub(ConsoleClient, "refreshTokens")
      .callsFake(async () => {
        currentToken = `rotated-${++refreshes}`;
        return { refresh_token: currentToken };
      });
    const encrypt = sandbox
      .stub(OSKeyStore, "encrypt")
      .callsFake(async token => {
        return token === "rotated-1" ? encryption.promise : `enc(${token})`;
      });
    sandbox
      .stub(OSKeyStore, "decrypt")
      .callsFake(async token => token.slice(4, -1));
    try {
      await FeltStorage.setLockingToken(email, "initial", "user-id");
      await ConsoleClient._refreshSession();
      await TestUtils.waitForCondition(() => encrypt.calledWith("rotated-1"));
      Assert.ok(
        setTokens.calledOnceWith("rotated-1", "", 4102444800),
        "The browser gets its token without waiting for persistence"
      );
      const next = ConsoleClient._refreshSession();
      await TestUtils.waitForTick();
      Assert.ok(
        refresh.calledOnce,
        "The next refresh waits behind the pending write"
      );
      if (mode === "drain") {
        actor.logoutReported = true;
        let drained = false;
        drain = actor._drainPendingRefresh().then(() => {
          drained = true;
        });
        await TestUtils.waitForTick();
        Assert.ok(!drained, "Teardown still waits for the older write");
      }
      if (mode === "keystore-failure") {
        encryption.reject(new Error("keystore unavailable"));
      } else {
        encryption.resolve("enc(rotated-1)");
      }
      if (mode === "drain") {
        await drain;
        ConsoleClient._finishBrowserRefresh(ConsoleClient._refreshRequest);
        await next;
        Assert.ok(refresh.calledOnce, "Teardown skips queued refreshes");
        Assert.ok(
          complete.calledOnce,
          "An ended session gets no reply for the queued refresh"
        );
        Assert.equal(await FeltStorage.getLockingToken(email), "rotated-1");
      } else {
        await next;
        // The reply does not wait for persistence, so let the write land.
        await actor._drainPendingRefresh();
        Assert.ok(refresh.calledTwice);
        Assert.ok(
          complete.calledTwice,
          "Both request IDs receive their own completion"
        );
        Assert.ok(
          setTokens.secondCall.calledWithExactly("rotated-2", "", 4102444800),
          "The queued refresh installs the newer token"
        );
        if (mode === "keystore-failure") {
          Assert.ok(
            !FeltStorage.hasLockingToken(email),
            "A keystore failure removes the spent stored credential"
          );
        } else {
          Assert.equal(
            await FeltStorage.getLockingToken(email),
            "rotated-2",
            "The newest rotated token remains stored"
          );
        }
      }
      Assert.ok(failed.notCalled, "Persistence does not end a healthy session");
    } finally {
      encryption.resolve("enc(rotated-1)");
      actor.logoutReported = true;
      await actor._drainPendingRefresh();
      ConsoleClient._finishBrowserRefresh(ConsoleClient._refreshRequest);
      FeltStorage.clearLockingToken(email);
      sandbox.restore();
    }
  }
});

add_task(async function test_network_loss_lock_cancels_pending_refresh() {
  // With the console gone, a refresh still in flight would only hold the lock,
  // and the FELT window, until its request timed out.
  const { ConsoleClient } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs"
  );
  const sandbox = sinon.createSandbox();
  const cancel = sandbox.stub(ConsoleClient, "cancelPendingRefresh");
  sandbox.stub(Services.cpmm, "sendAsyncMessage");
  const actor = new FeltProcessParent();
  const persist = sandbox.stub(actor, "_persistLockedSession").resolves(true);
  try {
    actor.exitReason = "networkLoss";
    await actor._lockAfterExit();
    sinon.assert.callOrder(cancel, persist);

    cancel.resetHistory();
    actor.exitReason = "";
    await actor._lockAfterExit();
    Assert.ok(
      cancel.notCalled,
      "An ordinary lock still lets an in-flight refresh land."
    );
  } finally {
    sandbox.restore();
  }
});
