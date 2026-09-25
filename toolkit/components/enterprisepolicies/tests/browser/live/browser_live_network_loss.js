/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ConsoleConnectionGuard, NETWORK_LOSS_ENFORCED_TOPIC } =
  ChromeUtils.importESModule(
    "resource://gre/modules/enterprise/ConsoleConnectionGuard.sys.mjs"
  );
const { ConsoleClient } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/ConsoleClient.sys.mjs"
);
const { ForcedQuitHandler } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/ForcedQuitHandler.sys.mjs"
);
const { PostureMonitor } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/DevicePosture.sys.mjs"
);

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

// The grace period has whole-minute granularity, so it cannot be waited out in
// a test. It is set far past the suite's lifetime and the tests drive the
// guard's _enforce() directly; the timer only ever matters for arm/cancel
// assertions.
const GRACE_PERIOD_MINUTES = 60;

// Restarting the engine from an empty set both clears the previous task's action
// and guarantees the next one lands: the engine diffs policy sets and skips an
// update that changes nothing, so re-applying an already-set action never fires.
function clearPolicies() {
  return EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );
}

// The prefs behind the NetworkLoss action ship locked, so they can only be
// driven through the policy engine.
async function setAction(action) {
  await clearPolicies();
  await waitForLivePolicyUpdate({
    SignOut: {
      NetworkLoss: { Action: action, GracePeriodMinutes: GRACE_PERIOD_MINUTES },
    },
  });
}

// performSignoutWithReason and setShutdownLockIntent are non-configurable XPCOM
// methods that cannot be stubbed on the real component. Replace the whole
// Services.felt getter with a minimal fake exposing just what the guard and
// EnterpriseHandler use, so the session end can be observed without actually
// ending it.
function stubFelt() {
  const lockIntentStub = sinon.stub();
  const signoutStub = sinon.stub();
  const fakeFelt = {
    isFeltUI: () => false,
    isFeltBrowser: () => true,
    setShutdownLockIntent: lockIntentStub,
    // Restoring the pref-driven intents syncs both, so the fake has to answer
    // for the restart one too even though nothing here asserts on it.
    setRestartLockIntent: sinon.stub(),
    performSignoutWithReason: signoutStub,
  };
  const feltGetterStub = sinon.stub(Services, "felt").get(() => fakeFelt);
  return {
    lockIntentStub,
    signoutStub,
    // Reset the guard before restoring the real Services.felt: the console is
    // unreachable in this environment, so a timer armed off a real poll
    // failure would otherwise fire against the fake and, with a lock action
    // applied, really quit the browser.
    async cleanup() {
      await clearPolicies();
      ConsoleConnectionGuard.reset();
      feltGetterStub.restore();
    },
  };
}

// The lock path really quits, so stub the forced quit and its result only while
// ending the session; the policy engine also uses Services.startup.
async function endSessionWithQuitStubbed() {
  const quitStub = sinon
    .stub(ForcedQuitHandler, "quitIgnoringCanClose")
    .resolves();
  const startupGetterStub = sinon
    .stub(Services, "startup")
    .get(() => ({ shuttingDown: true }));
  try {
    return {
      ended: await EnterpriseHandler.endSessionForNetworkLoss(),
      quitStub,
    };
  } finally {
    startupGetterStub.restore();
    quitStub.restore();
  }
}

registerCleanupFunction(async () => {
  await clearPolicies();
  ConsoleConnectionGuard.reset();
});

add_task(async function test_signout_action_enforced() {
  ConsoleConnectionGuard.reset();
  const { lockIntentStub, signoutStub, cleanup } = stubFelt();

  try {
    await setAction("signout");

    const enforced = TestUtils.topicObserved(NETWORK_LOSS_ENFORCED_TOPIC);
    await ConsoleConnectionGuard._enforce();
    const [, action] = await enforced;

    Assert.equal(action, "signout", "The enforced action is reported.");
    Assert.ok(
      signoutStub.calledOnceWith("networkLoss"),
      "performSignoutWithReason was called once with the networkLoss reason."
    );
    Assert.ok(
      lockIntentStub.calledOnceWith(false, "networkLoss"),
      "A fallback exit keeps the network-loss signout intent."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_felt_reachability_starts_browser_grace_period() {
  ConsoleConnectionGuard.reset();
  const { cleanup } = stubFelt();

  try {
    await setAction("lock");
    ConsoleClient.observe(null, "felt-firefox-console-unreachable");
    Assert.notEqual(
      ConsoleConnectionGuard._timer,
      null,
      "A failure reported by FELT starts the browser grace period."
    );
    ConsoleClient.observe(null, "felt-firefox-console-reachable");
    Assert.equal(
      ConsoleConnectionGuard._timer,
      null,
      "A recovery reported by FELT cancels the browser grace period."
    );
  } finally {
    await cleanup();
  }
});

// Network loss is always enforced: with no policy applied at all, a sustained
// loss still ends the session, with sign-out as the shipped default.
add_task(async function test_signout_enforced_without_policy() {
  ConsoleConnectionGuard.reset();
  const { signoutStub, cleanup } = stubFelt();

  try {
    await clearPolicies();

    const enforced = TestUtils.topicObserved(NETWORK_LOSS_ENFORCED_TOPIC);
    await ConsoleConnectionGuard._enforce();
    const [, action] = await enforced;

    Assert.equal(action, "signout", "The default action is signout.");
    Assert.ok(
      signoutStub.calledOnceWith("networkLoss"),
      "The session is signed out without any policy applied."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_unresponsive_felt_forces_signout_shutdown() {
  ConsoleConnectionGuard.reset();
  const { lockIntentStub, signoutStub, cleanup } = stubFelt();
  const startup = { shuttingDown: false };
  let startupGetterStub;
  let quitStub;

  try {
    await setAction("signout");
    startupGetterStub = sinon.stub(Services, "startup").get(() => startup);
    quitStub = sinon
      .stub(ForcedQuitHandler, "quitIgnoringCanClose")
      .callsFake(async () => {
        startup.shuttingDown = quitStub.callCount === 2;
      });
    await ConsoleConnectionGuard._enforce();
    Assert.notEqual(
      ConsoleConnectionGuard._shutdownWatchdog,
      null,
      "An accepted IPC request still has a shutdown watchdog."
    );

    await ConsoleConnectionGuard._forceNetworkLossShutdown();
    Assert.ok(
      quitStub.calledOnce,
      "An unresponsive FELT triggers a forced quit."
    );
    Assert.notEqual(
      ConsoleConnectionGuard._shutdownWatchdog,
      null,
      "A failed forced quit is retried."
    );
    await ConsoleConnectionGuard._forceNetworkLossShutdown();
    Assert.ok(quitStub.calledTwice, "The forced quit is retried.");
    Assert.ok(signoutStub.calledOnceWith("networkLoss"));
    Assert.ok(lockIntentStub.calledOnceWith(false, "networkLoss"));
    Assert.equal(ConsoleConnectionGuard._shutdownWatchdog, null);
  } finally {
    quitStub?.restore();
    startupGetterStub?.restore();
    await cleanup();
  }
});

add_task(async function test_lock_action_ends_session_with_intent() {
  ConsoleConnectionGuard.reset();
  const { lockIntentStub, signoutStub, cleanup } = stubFelt();

  try {
    await setAction("lock");

    const { ended, quitStub } = await endSessionWithQuitStubbed();

    Assert.ok(ended, "The session was reported as ended.");
    Assert.ok(
      lockIntentStub.calledOnceWith(true, "networkLoss"),
      "The lock intent was declared with the reason FELT explains it with."
    );
    Assert.ok(
      quitStub.calledOnce,
      "The browser was quit so the intent travels with the exit."
    );
    Assert.ok(
      lockIntentStub.calledBefore(quitStub),
      "The intent is declared before the quit, not after."
    );
    Assert.ok(signoutStub.notCalled, "The session was not signed out.");
  } finally {
    await cleanup();
  }
});

add_task(async function test_lock_uses_forced_quit() {
  ConsoleConnectionGuard.reset();
  const { lockIntentStub, signoutStub, cleanup } = stubFelt();

  try {
    await setAction("lock");

    const { ended, quitStub } = await endSessionWithQuitStubbed();
    Assert.ok(ended, "The forced quit ends the session.");
    Assert.ok(quitStub.calledOnce, "The forced quit hook is used.");
    Assert.ok(
      lockIntentStub.calledOnceWith(true, "networkLoss"),
      "The network-loss lock intent remains set for the forced exit."
    );
    Assert.ok(signoutStub.notCalled, "A successful lock does not sign out.");
  } finally {
    await cleanup();
  }
});

add_task(async function test_failed_forced_lock_signs_out() {
  ConsoleConnectionGuard.reset();
  const { lockIntentStub, signoutStub, cleanup } = stubFelt();

  try {
    await setAction("lock");

    const quitStub = sinon
      .stub(ForcedQuitHandler, "quitIgnoringCanClose")
      .resolves();
    const startupGetterStub = sinon
      .stub(Services, "startup")
      .get(() => ({ shuttingDown: false }));
    try {
      Assert.ok(
        await EnterpriseHandler.endSessionForNetworkLoss(),
        "The session is ended even if the forced quit is vetoed."
      );
      Assert.ok(quitStub.calledOnce, "The forced quit was attempted.");
      Assert.ok(
        signoutStub.calledOnceWith("networkLoss"),
        "A vetoed lock falls back to signout."
      );
      Assert.ok(
        lockIntentStub.firstCall.calledWithExactly(true, "networkLoss"),
        "The requested lock was attempted first."
      );
      Assert.ok(
        lockIntentStub.secondCall.calledWithExactly(false, "networkLoss"),
        "The vetoed lock changes to a signout intent."
      );
      Assert.ok(
        lockIntentStub.secondCall.calledBefore(signoutStub.firstCall),
        "The signout intent is set before the signout request."
      );
    } finally {
      startupGetterStub.restore();
      quitStub.restore();
    }
  } finally {
    await cleanup();
  }
});

// If the signout IPC call fails, the fallback is a plain quit, which FELT
// reads as an ordinary shutdown. The NetworkLoss action must still be the one
// that applies, or a Shutdown action of "lock" would leave a resumable session
// behind on a console we can no longer hear a revocation from.
add_task(async function test_signout_failure_still_applies_network_loss() {
  ConsoleConnectionGuard.reset();
  const { lockIntentStub, signoutStub, cleanup } = stubFelt();

  try {
    await setAction("signout");
    signoutStub.throws(new Error("no FELT client"));

    const { ended, quitStub } = await endSessionWithQuitStubbed();

    Assert.ok(ended, "The session is still reported as ended.");
    Assert.ok(quitStub.calledOnce, "The browser was quit anyway.");
    Assert.ok(
      lockIntentStub.calledWith(false, "networkLoss"),
      "The fallback quit carries the NetworkLoss action, not the Shutdown one."
    );
    Assert.ok(
      lockIntentStub.calledBefore(quitStub),
      "The intent is corrected before the quit it rides out on."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_reachable_cancels_grace_period() {
  ConsoleConnectionGuard.reset();
  const { cleanup } = stubFelt();

  try {
    await setAction("signout");

    ConsoleConnectionGuard.recordUnreachable();
    Assert.notEqual(
      ConsoleConnectionGuard._timer,
      null,
      "The first failure starts the grace period."
    );

    ConsoleConnectionGuard.recordReachable();
    Assert.equal(
      ConsoleConnectionGuard._timer,
      null,
      "A success before the grace period elapses cancels the session end."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_sustained_loss_enforces_once() {
  ConsoleConnectionGuard.reset();
  const { signoutStub, cleanup } = stubFelt();

  try {
    await setAction("signout");

    ConsoleConnectionGuard.recordUnreachable();
    const armed = ConsoleConnectionGuard._timer;
    ConsoleConnectionGuard.recordUnreachable();
    Assert.equal(
      ConsoleConnectionGuard._timer,
      armed,
      "A repeated failure does not restart the grace period."
    );

    const enforced = TestUtils.topicObserved(NETWORK_LOSS_ENFORCED_TOPIC);
    await ConsoleConnectionGuard._enforce();
    await enforced;

    ConsoleConnectionGuard.recordUnreachable();
    Assert.equal(
      ConsoleConnectionGuard._timer,
      null,
      "No new grace period is started once the session has been ended."
    );
    Assert.ok(
      signoutStub.calledOnce,
      "Sustained loss ends the session exactly once."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_failed_enforcement_retries_without_new_grace() {
  ConsoleConnectionGuard.reset();
  const { cleanup } = stubFelt();
  const endStub = sinon
    .stub(EnterpriseHandler, "endSessionForNetworkLoss")
    .resolves(false);

  try {
    await setAction("lock");
    ConsoleConnectionGuard.recordUnreachable();
    Assert.equal(
      await ConsoleConnectionGuard._enforce(),
      false,
      "The failed attempt is reported."
    );
    Assert.ok(endStub.calledOnce, "Enforcement was attempted once.");
    Assert.notEqual(
      ConsoleConnectionGuard._timer,
      null,
      "A short retry is armed without waiting for another poll."
    );
    ConsoleConnectionGuard.recordReachable();
    Assert.equal(
      ConsoleConnectionGuard._timer,
      null,
      "Console recovery cancels the retry."
    );
  } finally {
    endStub.restore();
    await cleanup();
  }
});

add_task(async function test_failed_posture_collection_still_checks_console() {
  const collectStub = sinon
    .stub(DevicePosture, "collect")
    .rejects(new Error("probe failed"));
  const refreshStub = sinon.stub(ConsoleClient, "refreshTokens").resolves({
    postureSubmitted: false,
  });
  const onRefreshed = sinon.stub();

  try {
    PostureMonitor.start({
      profileDir: null,
      intervalMs: 60000,
      onRefreshed,
      isSessionOver: () => false,
      onRefreshRejected: () => {},
    });
    await PostureMonitor.tick();

    Assert.ok(collectStub.calledOnce, "Posture collection was attempted.");
    Assert.ok(
      refreshStub.calledOnceWith({ posture: null }),
      "The console check still runs without a posture measurement."
    );
    Assert.ok(
      onRefreshed.calledOnce,
      "The refreshed session is still applied."
    );
  } finally {
    PostureMonitor.stop();
    PostureMonitor.forget();
    collectStub.restore();
    refreshStub.restore();
  }
});
