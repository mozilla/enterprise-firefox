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

add_task(function test_requests_updates_when_the_console_sets_a_deadline() {
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  const sandbox = sinon.createSandbox();
  try {
    sandbox.stub(RelaunchEnforcer, "_arm");
    sandbox.stub(RelaunchEnforcer, "_refreshNotification");
    sandbox.stub(RelaunchEnforcer, "_hideNotification");
    const request = sandbox.stub(RelaunchEnforcer, "_requestUpdateCheck");
    RelaunchEnforcer.onConsolePoll({ MinutesRemaining: "invalid" });
    Assert.ok(request.notCalled, "Malformed directives do not request updates");
    request
      .onFirstCall()
      .throws(
        Components.Exception("IPC not connected", Cr.NS_ERROR_NOT_CONNECTED)
      );
    RelaunchEnforcer.onConsolePoll({ MinutesRemaining: 45 });
    RelaunchEnforcer.onConsolePoll({ MinutesRemaining: 44 });
    Assert.equal(
      request.callCount,
      2,
      "Failed IPC is retried on the next poll"
    );
    RelaunchEnforcer.onConsolePoll({ MinutesRemaining: 43 });
    Assert.equal(
      request.callCount,
      2,
      "Repeated deadlines do not repeat the check"
    );
    RelaunchEnforcer._lastUpdateCheck -= 5 * MINUTE;
    RelaunchEnforcer.onConsolePoll({ MinutesRemaining: 38 });
    Assert.equal(
      request.callCount,
      3,
      "A continuing directive retries every five minutes"
    );
    RelaunchEnforcer.onConsolePoll(null);
    RelaunchEnforcer.onConsolePoll({ MinutesRemaining: 30 });
    Assert.equal(
      request.callCount,
      4,
      "A new directive requests another check"
    );
  } finally {
    RelaunchEnforcer.testingOnly_reset();
    sandbox.restore();
  }
});

add_task(function test_update_request_without_felt_is_a_noop() {
  Assert.ok(
    !Services.felt.isFeltBrowser(),
    "This test runs without a FELT browser"
  );
  RelaunchEnforcer._requestUpdateCheck();
});
