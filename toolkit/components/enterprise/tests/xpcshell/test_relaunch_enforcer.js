/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { RelaunchEnforcer } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/RelaunchEnforcer.sys.mjs"
);

const MINUTE = 60 * 1000;
const DAY = 24 * 60;
const NOW = 1_700_000_000_000;

// Minutes relative to NOW, so the expectations read as a timeline.
function at(minutes) {
  return NOW + minutes * MINUTE;
}

add_task(function test_uses_process_start_by_default() {
  const sessionStart = RelaunchEnforcer._sessionStart;
  const schedule = RelaunchEnforcer._computeRestartTime({
    now: sessionStart,
    params: { MinutesRemaining: 0 },
  });

  Assert.equal(
    schedule.restartAt,
    sessionStart + 10 * MINUTE,
    "The process start supplies the default grace-period floor"
  );
});

add_task(function test_derives_the_deadline_from_the_console_budget() {
  const cases = [
    {
      what: "an ordinary countdown uses the soft budget",
      sessionStart: at(-60),
      params: { MinutesRemaining: 45 },
      restartAt: at(45),
    },
    {
      what: "the grace period does not extend an unexpired soft budget",
      sessionStart: NOW,
      params: { MinutesRemaining: 30, GracePeriodMinutes: 10 },
      restartAt: at(30),
    },
    {
      what: "a fresh session past its soft budget gets the grace period",
      sessionStart: at(-2),
      params: { MinutesRemaining: 0, HardMinutesRemaining: 180 },
      restartAt: at(8),
    },
    {
      what: "the grace period floors a budget tighter than itself",
      sessionStart: NOW,
      params: { MinutesRemaining: 4, GracePeriodMinutes: 10 },
      restartAt: at(10),
    },
    {
      what: "the hard budget caps the grace period",
      sessionStart: NOW,
      params: {
        MinutesRemaining: 0,
        HardMinutesRemaining: 3,
        GracePeriodMinutes: 10,
      },
      restartAt: at(3),
    },
    {
      what: "a session past both budgets is overdue",
      sessionStart: at(-2),
      params: { MinutesRemaining: -5, HardMinutesRemaining: -1 },
      restartAt: at(-1),
    },
    {
      what: "an old session past its soft budget is overdue",
      sessionStart: at(-600),
      params: { MinutesRemaining: 0 },
      restartAt: NOW,
    },
    {
      what: "a zero grace period grants nothing",
      sessionStart: NOW,
      params: { MinutesRemaining: 0, GracePeriodMinutes: 0 },
      restartAt: NOW,
    },
    {
      what: "a hard budget tighter than the soft one is widened to match",
      sessionStart: NOW,
      params: {
        MinutesRemaining: 45,
        HardMinutesRemaining: 10,
        GracePeriodMinutes: 0,
      },
      restartAt: at(45),
    },
    {
      what: "a missing hard budget leaves the grace period uncapped",
      sessionStart: at(-2),
      params: { MinutesRemaining: 0 },
      restartAt: at(8),
    },
    {
      what: "a null optional field takes its default",
      sessionStart: at(-2),
      params: {
        MinutesRemaining: 0,
        HardMinutesRemaining: null,
        GracePeriodMinutes: null,
      },
      restartAt: at(8),
    },
    {
      what: "a budget past thirty days is capped there",
      sessionStart: NOW,
      params: {
        MinutesRemaining: 60 * DAY,
        HardMinutesRemaining: 90 * DAY,
        GracePeriodMinutes: 60 * DAY,
      },
      restartAt: at(30 * DAY),
    },
  ];

  for (const {
    what,
    sessionStart,
    params,
    restartAt: expectedRestartAt,
  } of cases) {
    const schedule = RelaunchEnforcer._computeRestartTime({
      now: NOW,
      sessionStart,
      params,
    });
    Assert.ok(schedule, `${what}: a schedule is produced`);
    Assert.equal(
      schedule.restartAt,
      expectedRestartAt,
      `${what}: restartAt is ${(expectedRestartAt - NOW) / MINUTE} minutes out`
    );
  }
});

add_task(function test_nothing_pending_for_an_unusable_budget() {
  const cases = [
    ["absent", null],
    ["undefined", undefined],
    ["a bare number", 45],
    ["a string", "45"],
    ["an empty object", {}],
    ["an array", []],
    ["a non-numeric budget", { MinutesRemaining: "45" }],
    ["a NaN budget", { MinutesRemaining: NaN }],
    ["an infinite budget", { MinutesRemaining: Infinity }],
    ["a null budget", { MinutesRemaining: null }],
    // A restart drops the user's work, so an optional field the console sends
    // that fails to parse withholds it.
    [
      "a non-numeric hard budget",
      { MinutesRemaining: 0, HardMinutesRemaining: "soon" },
    ],
    ["a NaN hard budget", { MinutesRemaining: 0, HardMinutesRemaining: NaN }],
    [
      "a non-numeric grace period",
      { MinutesRemaining: 0, GracePeriodMinutes: "ten" },
    ],
    [
      "a negative grace period",
      { MinutesRemaining: 0, GracePeriodMinutes: -30 },
    ],
  ];

  for (const [what, params] of cases) {
    Assert.equal(
      RelaunchEnforcer._computeRestartTime({
        now: NOW,
        sessionStart: NOW,
        params,
      }),
      null,
      `${what} means no restart is pending`
    );
  }
});

// There is no session restore in xpcshell, which is the state a deadline
// reached at "policies-startup" finds the browser in.
add_task(function test_a_deadline_before_session_restore_defers_the_restart() {
  Assert.ok(
    !("sessionRestored" in Services.startup.getStartupInfo()),
    "This session has not been restored"
  );

  RelaunchEnforcer._restart();

  Assert.ok(
    RelaunchEnforcer._awaitingSessionRestore,
    "The restart waits for session restore rather than dropping the tabs"
  );
  Assert.ok(
    !RelaunchEnforcer._restarting,
    "Nothing has been torn down for a restart yet"
  );

  // Idempotent: a later deadline must not stack a second observer.
  RelaunchEnforcer._restart();
  RelaunchEnforcer._stopAwaitingSessionRestore();
  Assert.ok(
    !RelaunchEnforcer._awaitingSessionRestore,
    "One withdrawal drops the wait"
  );
});

add_task(function test_warning_ui_delegate_is_startup_singleton() {
  const delegate = {
    showOrUpdate() {
      return true;
    },
    hide() {},
    isVisible() {
      return false;
    },
  };
  registerCleanupFunction(() => RelaunchEnforcer.testingOnly_reset());

  RelaunchEnforcer.registerWarningUIDelegate(delegate);
  Assert.throws(
    () => RelaunchEnforcer.registerWarningUIDelegate(delegate),
    /already registered/,
    "Only one warning UI delegate can be registered"
  );

  RelaunchEnforcer.testingOnly_reset();
  RelaunchEnforcer.onConsolePoll(null);
  Assert.throws(
    () => RelaunchEnforcer.registerWarningUIDelegate(delegate),
    /before console polling starts/,
    "The warning UI delegate must be selected before the first poll"
  );
  RelaunchEnforcer.testingOnly_reset();
});

add_task(async function test_application_warning_ui_delegate() {
  let visible = false;
  let hideCount = 0;
  let restartRequested = false;
  const updates = [];
  RelaunchEnforcer.registerWarningUIDelegate({
    showOrUpdate(details) {
      updates.push(details);
      visible = true;
      return true;
    },
    hide() {
      ++hideCount;
      visible = false;
    },
    isVisible() {
      return visible;
    },
  });
  registerCleanupFunction(() => RelaunchEnforcer.testingOnly_reset());

  const warningRestartAt = Date.now() + 45 * MINUTE;
  RelaunchEnforcer._schedule = { restartAt: warningRestartAt };
  await RelaunchEnforcer._refreshNotification();

  Assert.equal(updates.length, 1, "The delegate shows the warning");
  Assert.equal(updates[0].phase, "warning", "The warning phase is provided");
  Assert.equal(
    updates[0].restartAt,
    warningRestartAt,
    "The deadline is provided"
  );
  Assert.equal(updates[0].minutes, 45, "The remaining minutes are provided");

  await RelaunchEnforcer._refreshNotification();
  Assert.equal(
    updates.length,
    1,
    "Unchanged warning text does not touch the delegated UI"
  );

  const originalRestart = RelaunchEnforcer._restart;
  try {
    RelaunchEnforcer._restart = () => {
      restartRequested = true;
    };
    updates[0].restartNow();
  } finally {
    RelaunchEnforcer._restart = originalRestart;
  }
  Assert.ok(
    restartRequested,
    "The delegated restart action reaches the enforcer"
  );

  const imminentRestartAt = Date.now() + 4 * MINUTE;
  RelaunchEnforcer._schedule = { restartAt: imminentRestartAt };
  await RelaunchEnforcer._refreshNotification();

  Assert.equal(updates.length, 2, "The delegate updates the warning phase");
  Assert.equal(updates[1].phase, "imminent", "The imminent phase is provided");
  Assert.equal(updates[1].minutes, 4, "The imminent countdown is provided");

  RelaunchEnforcer.cancel();
  Assert.equal(hideCount, 1, "Withdrawing the deadline hides the delegated UI");
  Assert.ok(!visible, "The delegated warning is no longer visible");

  restartRequested = false;
  try {
    RelaunchEnforcer._restart = () => {
      restartRequested = true;
    };
    updates[1].restartNow();
  } finally {
    RelaunchEnforcer._restart = originalRestart;
  }
  Assert.ok(
    !restartRequested,
    "A warning action cannot restart after its deadline is withdrawn"
  );
  RelaunchEnforcer.testingOnly_reset();
});

add_task(async function test_visible_delegate_action_survives_failed_update() {
  let visible = false;
  let restartRequested = false;
  const updates = [];
  const updateStarted = Promise.withResolvers();
  const updateResult = Promise.withResolvers();
  RelaunchEnforcer.registerWarningUIDelegate({
    showOrUpdate(details) {
      updates.push(details);
      visible = true;
      if (updates.length === 2) {
        updateStarted.resolve();
        return updateResult.promise;
      }
      return true;
    },
    hide() {
      visible = false;
    },
    isVisible() {
      return visible;
    },
  });
  registerCleanupFunction(() => RelaunchEnforcer.testingOnly_reset());

  RelaunchEnforcer._schedule = {
    restartAt: Date.now() + 45 * MINUTE,
  };
  await RelaunchEnforcer._refreshNotification();

  const originalRestart = RelaunchEnforcer._restart;
  try {
    RelaunchEnforcer._restart = () => {
      restartRequested = true;
    };
    RelaunchEnforcer._schedule = {
      restartAt: Date.now() + 4 * MINUTE,
    };
    const updatePromise = RelaunchEnforcer._updateDelegatedWarning();
    await updateStarted.promise;

    updates[0].restartNow();
    Assert.ok(
      restartRequested,
      "The visible warning action works while its update is pending"
    );

    restartRequested = false;
    updateResult.reject(new Error("Expected warning update failure"));
    await Assert.rejects(
      updatePromise,
      /Expected warning update failure/,
      "The delegate update rejects"
    );
    updates[0].restartNow();
    Assert.ok(
      restartRequested,
      "The visible warning action survives a failed update"
    );

    RelaunchEnforcer.cancel();
    restartRequested = false;
    updates[0].restartNow();
    Assert.ok(
      !restartRequested,
      "Hiding the warning invalidates its restart action"
    );
  } finally {
    updateResult.resolve(false);
    RelaunchEnforcer._restart = originalRestart;
  }
  RelaunchEnforcer.testingOnly_reset();
});
