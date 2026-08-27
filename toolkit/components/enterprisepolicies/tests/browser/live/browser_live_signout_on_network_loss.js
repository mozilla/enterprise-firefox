/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ConsoleConnectionGuard } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/ConsoleConnectionGuard.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

// The grace period is consumed as whole seconds, so 1 is the smallest usable value.
const GRACE_PERIOD_S = 1;
const GRACE_PERIOD_MS = GRACE_PERIOD_S * 1000;

async function enableGuard(enabled) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["enterprise.signout.network_loss.enabled", enabled],
      ["enterprise.signout.network_loss.grace_period", GRACE_PERIOD_S],
    ],
  });
}

// performSignoutWithReason is a non-configurable XPCOM method that cannot be
// stubbed on the real component. Replace the whole Services.felt getter with a
// minimal fake exposing just what the guard uses: isFeltUI (kept on the browser
// path) and performSignoutWithReason (to observe calls without ending the session).
function stubSignout() {
  const signoutStub = sinon.stub();
  const fakeFelt = {
    isFeltUI: () => false,
    performSignoutWithReason: signoutStub,
  };
  const getterStub = sinon.stub(Services, "felt").get(() => fakeFelt);
  return {
    signoutStub,
    cleanup() {
      getterStub.restore();
      ConsoleConnectionGuard.reset();
    },
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

add_task(async function test_signout_after_grace_period() {
  ConsoleConnectionGuard.reset();
  await enableGuard(true);
  const { signoutStub, cleanup } = stubSignout();

  try {
    ConsoleConnectionGuard.recordUnreachable();
    await TestUtils.waitForCondition(
      () => signoutStub.called,
      "Waiting for the network-loss sign-out to be triggered"
    );
    Assert.ok(
      signoutStub.calledOnce,
      "performSignoutWithReason was called once."
    );
    Assert.ok(
      signoutStub.calledWith("networkLoss"),
      "performSignoutWithReason was called with the networkLoss reason."
    );
  } finally {
    cleanup();
  }
});

add_task(async function test_no_signout_when_disabled() {
  ConsoleConnectionGuard.reset();
  await enableGuard(false);
  const { signoutStub, cleanup } = stubSignout();

  try {
    ConsoleConnectionGuard.recordUnreachable();
    await wait(GRACE_PERIOD_MS + 500);
    Assert.ok(
      signoutStub.notCalled,
      "No sign-out is triggered while the policy is disabled."
    );
  } finally {
    cleanup();
  }
});

add_task(async function test_reachable_resets_grace_period() {
  ConsoleConnectionGuard.reset();
  await enableGuard(true);
  const { signoutStub, cleanup } = stubSignout();

  try {
    ConsoleConnectionGuard.recordUnreachable();
    await wait(GRACE_PERIOD_MS / 2);
    ConsoleConnectionGuard.recordReachable();
    await wait(GRACE_PERIOD_MS + 500);
    Assert.ok(
      signoutStub.notCalled,
      "A success before the grace period elapses cancels the sign-out."
    );
  } finally {
    cleanup();
  }
});

add_task(async function test_sustained_loss_triggers_single_signout() {
  ConsoleConnectionGuard.reset();
  await enableGuard(true);
  const { signoutStub, cleanup } = stubSignout();

  try {
    ConsoleConnectionGuard.recordUnreachable();
    ConsoleConnectionGuard.recordUnreachable();
    await TestUtils.waitForCondition(
      () => signoutStub.called,
      "Waiting for the network-loss sign-out to be triggered"
    );
    ConsoleConnectionGuard.recordUnreachable();
    await wait(GRACE_PERIOD_MS + 500);
    Assert.ok(
      signoutStub.calledOnce,
      "Sustained loss triggers exactly one sign-out."
    );
  } finally {
    cleanup();
  }
});
