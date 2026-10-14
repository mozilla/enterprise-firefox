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

// An unreachable console is the browser's network-loss grace period's call, not
// FELT's; only a console that answered and refused ends the session here.
add_task(function test_transport_refresh_failure_leaves_session_alive() {
  const { ConsoleClient } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs"
  );
  const { PostureMonitor } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/enterprise/modules/DevicePosture.sys.mjs"
  );
  const sandbox = sinon.createSandbox();
  const shutdownFirefox = sandbox.stub();
  const clearLockAndTokens = sandbox.stub(FeltLocking, "clearLockAndTokens");
  sandbox.stub(PostureMonitor, "stop");
  sandbox.stub(Services, "felt").get(() => ({ shutdownFirefox }));
  const actor = new FeltProcessParent();
  actor.proc = { exitPromise: new Promise(() => {}) };
  const { TypeError } = Cu.getGlobalForObject(ConsoleClient);
  try {
    for (const message of ["ConsoleClientXHRError", "NS_ERROR_NET_TIMEOUT"]) {
      actor.endSessionAfterRefreshFailure(new TypeError(message));
    }
    Assert.ok(
      shutdownFirefox.notCalled,
      "A transport failure does not shut the browser down."
    );
    Assert.ok(
      clearLockAndTokens.notCalled,
      "A transport failure keeps the session credentials."
    );
    Assert.ok(!actor.logoutReported, "The session is still live.");

    actor.endSessionAfterRefreshFailure(
      new Error("Token refresh failed: , Status: 500")
    );
    Assert.ok(
      shutdownFirefox.calledOnce,
      "A refused refresh ends the session."
    );
    Assert.ok(
      clearLockAndTokens.calledOnce,
      "A refused refresh drops the credentials."
    );
    Assert.ok(actor.logoutReported, "The session is reported as over.");
  } finally {
    sandbox.restore();
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
    actor.browserObserver.observe(null, "felt-firefox-refresh-tokens", "10");
    actor.browserObserver.observe(null, "felt-firefox-refresh-tokens", "11");
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
    actor.browserObserver.observe(null, "felt-firefox-refresh-tokens", "12");
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
    actor.browserObserver.observe(null, "felt-firefox-refresh-tokens", "20");
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

add_task(
  async function test_refresh_persistence_survives_timeout_and_teardown() {
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
    for (const mode of ["retry", "drain", "keystore-failure"]) {
      const sandbox = sinon.createSandbox();
      const encryption = Promise.withResolvers();
      let currentToken;
      let drain;
      const actor = new FeltProcessParent();
      const setTokens = sandbox.stub();
      const complete = sandbox.stub().callsFake((requestId, error) => {
        ConsoleClient.observe(
          null,
          "felt-firefox-token-refresh-result",
          JSON.stringify({
            request_id: requestId,
            access_token: currentToken,
            expires_at: 4102444800,
            error,
          })
        );
      });
      sandbox.stub(Services, "felt").get(() => ({
        isFeltBrowser: () => true,
        refreshTokens: requestId =>
          actor.browserObserver.observe(
            null,
            "felt-firefox-refresh-tokens",
            String(requestId)
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
        const first = ConsoleClient._refreshSession();
        const firstRequest = ConsoleClient._refreshRequest;
        await TestUtils.waitForCondition(() => encrypt.calledWith("rotated-1"));
        Assert.ok(complete.notCalled, "Completion waits for token persistence");
        ConsoleClient._onBrowserRefreshTimeout(firstRequest);
        await Assert.rejects(first, /NS_ERROR_NET_TIMEOUT/);
        const retry = ConsoleClient._refreshSession();
        await TestUtils.waitForTick();
        Assert.ok(
          refresh.calledOnce,
          "A timeout retry waits behind the pending write"
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
          await retry;
          Assert.ok(refresh.calledOnce, "Teardown skips queued refreshes");
          Assert.ok(
            complete.notCalled,
            "An ended session gets no success reply"
          );
          Assert.equal(await FeltStorage.getLockingToken(email), "rotated-1");
        } else {
          await retry;
          Assert.ok(refresh.calledTwice);
          Assert.ok(
            complete.calledTwice,
            "Both request IDs receive their own completion"
          );
          Assert.ok(
            setTokens.calledOnceWith("rotated-2", "", 4102444800),
            "Only the retry installs a browser token"
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
        Assert.ok(
          failed.notCalled,
          "Persistence does not end a healthy session"
        );
      } finally {
        encryption.resolve("enc(rotated-1)");
        actor.logoutReported = true;
        await actor._drainPendingRefresh();
        ConsoleClient._finishBrowserRefresh(ConsoleClient._refreshRequest);
        FeltStorage.clearLockingToken(email);
        sandbox.restore();
      }
    }
  }
);
