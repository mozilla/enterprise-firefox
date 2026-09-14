/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ConsoleConnectionGuard, CONNECTION_LOSS_ENFORCED_TOPIC } =
  ChromeUtils.importESModule(
    "resource://gre/modules/enterprise/ConsoleConnectionGuard.sys.mjs"
  );
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

// The grace period is consumed as whole seconds, so 1 is the smallest usable value.
const GRACE_PERIOD_S = 1;

// Restarting the engine from an empty set both clears the previous task's action
// and guarantees the next one lands: the engine diffs policy sets and skips an
// update that changes nothing, so re-applying an already-set action never fires.
function clearPolicies() {
  return EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );
}

// The prefs behind the ConnectionLoss action ship locked, so they can only be
// driven through the policy engine.
async function setAction(action) {
  await clearPolicies();
  await waitForLivePolicyUpdate({
    SignOut: {
      ConnectionLoss: { Action: action, GracePeriod: GRACE_PERIOD_S },
    },
  });
}

// performSignoutWithReason and setCloseLockIntent are non-configurable XPCOM
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
    setCloseLockIntent: lockIntentStub,
    performSignoutWithReason: signoutStub,
  };
  const feltGetterStub = sinon.stub(Services, "felt").get(() => fakeFelt);
  return {
    lockIntentStub,
    signoutStub,
    // Drop the action before restoring the real Services.felt: the console is
    // unreachable in this environment, so an action left applied would let the
    // guard arm off a real poll failure and end the actual session.
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
    return { ended: EnterpriseHandler.endSessionForConnectionLoss(), quitStub };
  } finally {
    startupGetterStub.restore();
  }
}

registerCleanupFunction(async () => {
  await clearPolicies();
  ConsoleConnectionGuard.reset();
});

add_task(async function test_signout_action_after_grace_period() {
  ConsoleConnectionGuard.reset();
  const { lockIntentStub, signoutStub, cleanup } = stubFelt();

  try {
    await setAction("signout");

    const enforced = TestUtils.topicObserved(CONNECTION_LOSS_ENFORCED_TOPIC);
    ConsoleConnectionGuard.recordUnreachable();
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
// session is then still running, so the intent must go back to what the close
// pref dictates and the caller must learn the session did not end.
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
      ended = EnterpriseHandler.endSessionForConnectionLoss();
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
      [EnterpriseHandler.willLockOnClose, ""],
      "The restored intent is the close pref's, with the reason cleared."
    );
    Assert.ok(
      !EnterpriseHandler._skipSignoutPrompt,
      "The next close prompts again."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_no_grace_period_when_action_is_none() {
  ConsoleConnectionGuard.reset();
  const { cleanup } = stubFelt();

  try {
    await setAction("none");

    ConsoleConnectionGuard.recordUnreachable();
    Assert.equal(
      ConsoleConnectionGuard._timer,
      null,
      'No grace period is started while the action is "none".'
    );
  } finally {
    await cleanup();
  }
});

// Removing the policy must stop the guard without a restart.
add_task(async function test_policy_removal_disables_guard() {
  ConsoleConnectionGuard.reset();
  const { cleanup } = stubFelt();

  try {
    await setAction("signout");
    await waitForLivePolicyUpdate({});

    ConsoleConnectionGuard.recordUnreachable();
    Assert.equal(
      ConsoleConnectionGuard._timer,
      null,
      "No grace period is started once the policy is removed."
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

    const enforced = TestUtils.topicObserved(CONNECTION_LOSS_ENFORCED_TOPIC);
    ConsoleConnectionGuard.recordUnreachable();
    const armed = ConsoleConnectionGuard._timer;
    ConsoleConnectionGuard.recordUnreachable();
    Assert.equal(
      ConsoleConnectionGuard._timer,
      armed,
      "A repeated failure does not restart the grace period."
    );

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
