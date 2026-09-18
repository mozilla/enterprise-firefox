/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ConsoleConnectionGuard, NETWORK_LOSS_ENFORCED_TOPIC } =
  ChromeUtils.importESModule(
    "resource://gre/modules/enterprise/ConsoleConnectionGuard.sys.mjs"
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

// The lock path really quits, so Services.startup is swapped for the single
// synchronous call only: a fake left in place breaks unrelated consumers (the
// policy engine reads getStartupInfo off it).
function endSessionWithQuitStubbed() {
  const quitStub = sinon.stub().returns(true);
  const startupGetterStub = sinon
    .stub(Services, "startup")
    .get(() => ({ quit: quitStub }));
  try {
    return { ended: EnterpriseHandler.endSessionForNetworkLoss(), quitStub };
  } finally {
    startupGetterStub.restore();
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
    ConsoleConnectionGuard._enforce();
    const [, action] = await enforced;

    Assert.equal(action, "signout", "The enforced action is reported.");
    Assert.ok(
      signoutStub.calledOnceWith("networkLoss"),
      "performSignoutWithReason was called once with the networkLoss reason."
    );
    Assert.ok(lockIntentStub.notCalled, "No lock intent was declared.");
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
    ConsoleConnectionGuard._enforce();
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

add_task(async function test_lock_action_ends_session_with_intent() {
  ConsoleConnectionGuard.reset();
  const { lockIntentStub, signoutStub, cleanup } = stubFelt();

  try {
    await setAction("lock");

    const { ended, quitStub } = endSessionWithQuitStubbed();

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

// A beforeunload handler can veto the quit the lock intent rides out on. The
// session is then still running, so the intent must go back to what the
// shutdown pref dictates and the caller must learn the session did not end.
add_task(async function test_vetoed_lock_quit_restores_intent() {
  ConsoleConnectionGuard.reset();
  const { lockIntentStub, cleanup } = stubFelt();

  try {
    await setAction("lock");

    const quitStub = sinon.stub().returns(false);
    const startupGetterStub = sinon
      .stub(Services, "startup")
      .get(() => ({ quit: quitStub }));
    let ended;
    try {
      ended = EnterpriseHandler.endSessionForNetworkLoss();
    } finally {
      startupGetterStub.restore();
    }

    Assert.ok(!ended, "A vetoed quit reports the session as still running.");
    Assert.ok(
      lockIntentStub.calledTwice,
      "The intent is declared and then restored."
    );
    Assert.deepEqual(
      lockIntentStub.secondCall.args,
      [EnterpriseHandler.willLockOnShutdown, ""],
      "The restored intent is the shutdown pref's, with the reason cleared."
    );
    Assert.ok(
      !EnterpriseHandler._skipSignoutPrompt,
      "The next close prompts again."
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
    ConsoleConnectionGuard._enforce();
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
