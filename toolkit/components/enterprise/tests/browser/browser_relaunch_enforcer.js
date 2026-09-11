/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { RelaunchEnforcer } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/RelaunchEnforcer.sys.mjs"
);
const { InfoBar } = ChromeUtils.importESModule(
  "resource:///modules/asrouter/InfoBar.sys.mjs"
);

const WARNING_ID = "ENTERPRISE_RELAUNCH_WARNING";
const IMMINENT_ID = "ENTERPRISE_RELAUNCH_IMMINENT";

function notificationValues(win) {
  return [...win.gNotificationBox.allNotifications].map(n =>
    n.getAttribute("value")
  );
}

// <remote-text> renders the message into an open shadow root.
function notificationFluentId(win, value) {
  const notification = [...win.gNotificationBox.allNotifications].find(
    n => n.getAttribute("value") === value
  );
  return notification
    ?.querySelector("remote-text")
    ?.getAttribute("fluent-remote-id");
}

// Every task starts from here, so a failing task cannot fail the ones after it.
async function reset(win) {
  RelaunchEnforcer.testingOnly_reset();
  win.gNotificationBox.removeAllNotifications(true);
  await TestUtils.waitForCondition(
    () => !notificationValues(win).length,
    "No infobar is left over from an earlier task"
  );
}

add_setup(async function () {
  const requestUpdateCheck = RelaunchEnforcer._requestUpdateCheck;
  RelaunchEnforcer._requestUpdateCheck = () => {};
  registerCleanupFunction(() => {
    RelaunchEnforcer._requestUpdateCheck = requestUpdateCheck;
  });
  registerCleanupFunction(() =>
    reset(Services.wm.getMostRecentBrowserWindow())
  );
});

add_task(async function test_warns_escalates_and_withdraws() {
  const win = Services.wm.getMostRecentBrowserWindow();
  await reset(win);
  Assert.deepEqual(
    notificationValues(win),
    [],
    "No relaunch bar before the console asks for a restart"
  );

  // A comfortable budget: the warning phase, and far enough out that neither
  // the restart nor the escalation task can fire during the test.
  let shown = BrowserTestUtils.waitForGlobalNotificationBar(win, WARNING_ID);
  RelaunchEnforcer.onConsolePoll({
    MinutesRemaining: 45,
    HardMinutesRemaining: 180,
  });
  await shown;

  Assert.deepEqual(
    notificationValues(win),
    [WARNING_ID],
    "The warning bar is shown"
  );

  await TestUtils.waitForCondition(
    () =>
      notificationFluentId(win, WARNING_ID) ===
      "enterprise-relaunch-warning-message",
    "The warning bar carries the warning string"
  );

  let state = RelaunchEnforcer.testingOnly_getState();
  Assert.ok(state.restartArmed, "The restart is armed");
  Assert.ok(state.escalationArmed, "The escalation is armed");
  Assert.equal(state.shownPhase, WARNING_ID, "The warning phase is recorded");

  // Re-stating the same budget leaves the bar alone.
  const notification = win.gNotificationBox.allNotifications[0];
  RelaunchEnforcer.onConsolePoll({
    MinutesRemaining: 45,
    HardMinutesRemaining: 180,
  });
  Assert.equal(
    win.gNotificationBox.allNotifications[0],
    notification,
    "An unchanged budget leaves the existing bar in place"
  );

  // A moved deadline is written into the bar that is up. Re-showing it under
  // the same id would leave the new bar outside InfoBar's bookkeeping.
  const datetime = () =>
    notification
      .querySelector("remote-text")
      .getAttribute("fluent-variable-datetime");
  const before = datetime();
  RelaunchEnforcer.onConsolePoll({
    MinutesRemaining: 30,
    HardMinutesRemaining: 180,
  });
  await TestUtils.waitForCondition(
    () => datetime() !== before,
    "The warning bar takes the moved deadline"
  );
  Assert.deepEqual(
    notificationValues(win),
    [WARNING_ID],
    "A moved deadline updated the bar rather than stacking a second one"
  );
  Assert.equal(
    win.gNotificationBox.allNotifications[0],
    notification,
    "A moved deadline kept the bar that was up"
  );
  Assert.equal(
    InfoBar._activeInfobar.message.content.attributes.datetime,
    Number(datetime()),
    "A window opened from here on would be served the moved deadline"
  );

  // A zero grace period lets the soft budget govern this seconds-old session.
  shown = BrowserTestUtils.waitForGlobalNotificationBar(win, IMMINENT_ID);
  RelaunchEnforcer.onConsolePoll({
    MinutesRemaining: 4,
    GracePeriodMinutes: 0,
  });
  await shown;

  Assert.deepEqual(
    notificationValues(win),
    [IMMINENT_ID],
    "The imminent bar replaced the warning bar rather than stacking on it"
  );

  await TestUtils.waitForCondition(
    () =>
      notificationFluentId(win, IMMINENT_ID) ===
      "enterprise-relaunch-imminent-message",
    "The imminent bar carries the imminent string"
  );

  state = RelaunchEnforcer.testingOnly_getState();
  Assert.equal(state.shownPhase, IMMINENT_ID, "The imminent phase is recorded");
  Assert.equal(state.shownMinutes, 4, "The remaining minutes are recorded");
  Assert.ok(
    !state.escalationArmed,
    "No escalation is armed once the threshold has been crossed"
  );

  RelaunchEnforcer.onConsolePoll(null);
  await TestUtils.waitForCondition(
    () => !notificationValues(win).length,
    "The relaunch bar goes away"
  );

  state = RelaunchEnforcer.testingOnly_getState();
  Assert.equal(state.schedule, null, "No deadline is held");
  Assert.ok(!state.restartArmed, "The restart is disarmed");
  Assert.ok(!state.restarting, "No restart was triggered");
});

add_task(async function test_malformed_budget_withdraws() {
  const win = Services.wm.getMostRecentBrowserWindow();
  await reset(win);

  const shown = BrowserTestUtils.waitForGlobalNotificationBar(win, WARNING_ID);
  RelaunchEnforcer.onConsolePoll({ MinutesRemaining: 45 });
  await shown;

  RelaunchEnforcer.onConsolePoll({ MinutesRemaining: "soon" });
  await TestUtils.waitForCondition(
    () => !notificationValues(win).length,
    "The relaunch bar goes away"
  );

  const state = RelaunchEnforcer.testingOnly_getState();
  Assert.equal(state.schedule, null, "No deadline is held");
  Assert.ok(!state.restartArmed, "The restart is disarmed");
  Assert.ok(!state.restarting, "No restart was triggered");
});

add_task(async function test_the_countdown_keeps_the_bar_and_its_focus() {
  const win = Services.wm.getMostRecentBrowserWindow();
  await reset(win);

  const shown = BrowserTestUtils.waitForGlobalNotificationBar(win, IMMINENT_ID);
  RelaunchEnforcer.onConsolePoll({
    MinutesRemaining: 4,
    GracePeriodMinutes: 0,
  });
  await shown;

  const notification =
    win.gNotificationBox.getNotificationWithValue(IMMINENT_ID);
  const button = notification.buttonContainer.querySelector("button");
  button.focus();

  RelaunchEnforcer.onConsolePoll({
    MinutesRemaining: 3,
    GracePeriodMinutes: 0,
  });
  await TestUtils.waitForCondition(
    () => RelaunchEnforcer.testingOnly_getState().shownMinutes === 3,
    "The countdown reaches three minutes"
  );

  Assert.equal(
    win.gNotificationBox.getNotificationWithValue(IMMINENT_ID),
    notification,
    "The countdown updated the bar that was up"
  );
  Assert.equal(
    win.document.activeElement,
    button,
    "The restart button kept focus"
  );
  Assert.strictEqual(
    notification
      .querySelector("remote-text")
      .getAttribute("fluent-variable-minutes"),
    "3",
    "The bar carries the new minute count"
  );

  RelaunchEnforcer.onConsolePoll(null);
  await TestUtils.waitForCondition(
    () => !notificationValues(win).length,
    "The relaunch bar goes away"
  );
});

add_task(async function test_returns_after_the_bar_is_removed() {
  const win = Services.wm.getMostRecentBrowserWindow();
  await reset(win);

  let shown = BrowserTestUtils.waitForGlobalNotificationBar(win, WARNING_ID);
  RelaunchEnforcer.onConsolePoll({ MinutesRemaining: 45 });
  await shown;

  InfoBar._activeInfobar.notification.removeUniversalInfobars();
  await TestUtils.waitForCondition(
    () => !notificationValues(win).length,
    "The bar is gone"
  );

  // A refresh deriving the same text as the removed bar.
  shown = BrowserTestUtils.waitForGlobalNotificationBar(win, WARNING_ID);
  await RelaunchEnforcer._refreshNotification();
  await shown;

  Assert.deepEqual(
    notificationValues(win),
    [WARNING_ID],
    "The warning bar came back"
  );

  RelaunchEnforcer.onConsolePoll(null);
  await TestUtils.waitForCondition(
    () => !notificationValues(win).length,
    "The relaunch bar goes away"
  );
});

add_task(async function test_takes_the_slot_from_another_infobar() {
  const win = Services.wm.getMostRecentBrowserWindow();
  await reset(win);
  const incumbentId = "INFOBAR_LAUNCH_ON_LOGIN";

  await InfoBar.showInfoBarMessage(
    win.gBrowser.selectedBrowser,
    {
      id: incumbentId,
      content: {
        type: "global",
        priority: win.gNotificationBox.PRIORITY_INFO_HIGH,
        text: "Occupying the slot",
        buttons: [],
      },
      template: "infobar",
      targeting: "true",
    },
    () => {}
  );
  Assert.deepEqual(
    notificationValues(win),
    [incumbentId],
    "Another infobar holds the slot"
  );

  const shown = BrowserTestUtils.waitForGlobalNotificationBar(win, WARNING_ID);
  RelaunchEnforcer.onConsolePoll({ MinutesRemaining: 45 });
  await shown;

  Assert.deepEqual(
    notificationValues(win),
    [WARNING_ID],
    "The relaunch bar took the slot from the incumbent"
  );

  RelaunchEnforcer.onConsolePoll(null);
  await TestUtils.waitForCondition(
    () => !notificationValues(win).length,
    "The relaunch bar goes away"
  );
});

add_task(async function test_retries_after_the_browser_window_loads() {
  const win = Services.wm.getMostRecentBrowserWindow();
  await reset(win);

  const loadingWin = win.OpenBrowserWindow();
  const started = TestUtils.topicObserved(
    "browser-delayed-startup-finished",
    subject => subject == loadingWin
  );
  try {
    await BrowserTestUtils.waitForEvent(loadingWin, "DOMContentLoaded");
    Assert.equal(
      loadingWin.document.readyState,
      "interactive",
      "The new window is still loading"
    );

    // Model startup by making the loading window the only eligible target.
    win.document.documentElement.setAttribute("taskbartab", "true");
    RelaunchEnforcer.onConsolePoll({ MinutesRemaining: 45 });
    await RelaunchEnforcer._refreshNotification();
    win.document.documentElement.removeAttribute("taskbartab");

    await started;
    const shown = BrowserTestUtils.waitForGlobalNotificationBar(
      loadingWin,
      WARNING_ID
    );
    RelaunchEnforcer.onConsolePoll({ MinutesRemaining: 45 });
    await shown;

    Assert.deepEqual(
      notificationValues(loadingWin),
      [WARNING_ID],
      "The warning is shown after the window loads"
    );
  } finally {
    win.document.documentElement.removeAttribute("taskbartab");
    RelaunchEnforcer.onConsolePoll(null);
    await started;
    await BrowserTestUtils.closeWindow(loadingWin);
  }
});

add_task(async function test_warns_in_a_window_that_can_take_a_bar() {
  const win = Services.wm.getMostRecentBrowserWindow();
  await reset(win);

  // InfoBar refuses a private window, and the most recent window is the one
  // the user just opened.
  const privateWin = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  Assert.equal(
    Services.wm.getMostRecentBrowserWindow(),
    privateWin,
    "The private window is the most recent one"
  );

  RelaunchEnforcer.onConsolePoll({ MinutesRemaining: 45 });
  await RelaunchEnforcer._refreshNotification();

  Assert.deepEqual(
    notificationValues(win),
    [WARNING_ID],
    "The warning went to the window that can show it"
  );
  Assert.deepEqual(
    notificationValues(privateWin),
    [],
    "No warning in the private window"
  );

  RelaunchEnforcer.onConsolePoll(null);
  await TestUtils.waitForCondition(
    () => !notificationValues(win).length,
    "The relaunch bar goes away"
  );
  await BrowserTestUtils.closeWindow(privateWin);
});
