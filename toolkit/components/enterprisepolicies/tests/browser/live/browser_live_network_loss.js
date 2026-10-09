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
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

// The grace period has whole-minute granularity, so it cannot be waited out in
// a test. It is set far past the suite's lifetime and the tests drive the
// guard directly.
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
    // A successful enforcement arms the real shutdown watchdog, so reset before
    // the engine restart or a slow restart lets it quit the browser. Reset again
    // after: the console is unreachable here, so the restart's own poll failure
    // arms a fresh timer. The skipped prompt is only cleared by a real quit.
    async cleanup() {
      ConsoleConnectionGuard.reset();
      EnterpriseHandler._skipSignoutPrompt = false;
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
  ConsoleConnectionGuard.reset();
  EnterpriseHandler._skipSignoutPrompt = false;
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

// Network-loss enforcement is opt-in, so an outage leaves the session alone
// both with no policy at all and with the "none" action set explicitly.
add_task(async function test_disabled_enforcement_leaves_the_session_alone() {
  for (const scenario of ["no policy", "none action"]) {
    ConsoleConnectionGuard.reset();
    const { signoutStub, lockIntentStub, cleanup } = stubFelt();
    const enforcedObserver = sinon.stub();
    Services.obs.addObserver(enforcedObserver, NETWORK_LOSS_ENFORCED_TOPIC);

    try {
      info(`Enforcing with ${scenario}`);
      if (scenario === "no policy") {
        await clearPolicies();
      } else {
        await setAction("none");
      }

      Assert.strictEqual(
        await ConsoleConnectionGuard._enforce(),
        false,
        `Enforcement is disabled with ${scenario}.`
      );
      Assert.ok(signoutStub.notCalled, "The session stays signed in.");
      Assert.ok(lockIntentStub.notCalled, "No lock intent is declared.");
      Assert.ok(
        enforcedObserver.notCalled,
        `No ${NETWORK_LOSS_ENFORCED_TOPIC} notification is sent.`
      );
    } finally {
      Services.obs.removeObserver(
        enforcedObserver,
        NETWORK_LOSS_ENFORCED_TOPIC
      );
      await cleanup();
    }
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

add_task(
  async function test_recovery_during_failed_enforcement_cancels_retry() {
    ConsoleConnectionGuard.reset();
    const { cleanup } = stubFelt();
    const attempt = Promise.withResolvers();
    const endStub = sinon
      .stub(EnterpriseHandler, "endSessionForNetworkLoss")
      .returns(attempt.promise);
    try {
      await setAction("lock");
      ConsoleConnectionGuard.recordUnreachable();
      const enforcing = ConsoleConnectionGuard._enforce();
      ConsoleConnectionGuard.recordReachable();
      attempt.resolve(false);
      Assert.equal(await enforcing, false);
      Assert.equal(
        ConsoleConnectionGuard._timer,
        null,
        "Recovery prevents a retry."
      );
      Assert.equal(ConsoleConnectionGuard._outageStartedAt, null);
    } finally {
      attempt.resolve(false);
      endStub.restore();
      await cleanup();
    }
  }
);

add_task(async function test_enforcement_retry_rechecks_reachability() {
  ConsoleConnectionGuard.reset();
  const { cleanup } = stubFelt();
  const endStub = sinon
    .stub(EnterpriseHandler, "endSessionForNetworkLoss")
    .resolves(false);
  const probe = sinon.stub(ConsoleClient, "probeConsoleReachable").resolves();
  try {
    await setAction("lock");
    ConsoleConnectionGuard.recordUnreachable();
    ConsoleConnectionGuard._outageStartedAt -= GRACE_PERIOD_MINUTES * 60 * 1000;
    await ConsoleConnectionGuard._enforce();
    Assert.notEqual(
      ConsoleConnectionGuard._timer,
      null,
      "A failed enforcement arms a retry."
    );
    await ConsoleConnectionGuard._verifyBeforeEnforcing();
    Assert.equal(
      ConsoleConnectionGuard._outageStartedAt,
      null,
      "The retry discovers recovery without another policy poll."
    );
    Assert.ok(probe.calledOnce, "The retry probes the console.");
    Assert.ok(
      endStub.calledOnce,
      "Recovery prevents another enforcement attempt."
    );
    Assert.equal(ConsoleConnectionGuard._timer, null);
  } finally {
    probe.restore();
    endStub.restore();
    await cleanup();
  }
});
