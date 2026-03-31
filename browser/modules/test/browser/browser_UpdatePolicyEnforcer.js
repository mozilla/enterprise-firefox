/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { InfoBar } = ChromeUtils.importESModule(
  "resource:///modules/asrouter/InfoBar.sys.mjs"
);
const {
  testingOnly_getTaskStatus,
  testingOnly_resetTasks,
  getCompulsoryRestartPolicy,
  UpdatePolicyEnforcer,
} = ChromeUtils.importESModule(
  "resource:///modules/UpdatePolicyEnforcer.sys.mjs"
);

const prefName = "app.update.compulsory_restart";

const prefValue = {
  NotificationPeriodHours: 0,
  RestartTimeOfDay: {
    Hour: 0,
    Minute: 30,
  },
};

function pushPrefs(...aPrefs) {
  return SpecialPowers.pushPrefEnv({ set: aPrefs });
}

function popPrefs() {
  return SpecialPowers.popPrefEnv();
}

/**
 * Tests that we can enable the blocking pref and block a refresh
 * from occurring while showing a notification bar. Also tests that
 * when we disable the pref, that refreshes can go through again.
 */
add_task(async function test_compulsoryRestartNotification() {
  await pushPrefs([prefName, JSON.stringify(prefValue)]);
  try {
    let win = Services.wm.getMostRecentBrowserWindow();
    Assert.equal(0, win.gNotificationBox.allNotifications.length);
    const notificationPromise = BrowserTestUtils.waitForGlobalNotificationBar(
      win,
      "COMPULSORY_RESTART_SCHEDULED"
    );
    Services.obs.notifyObservers(null, "update-downloaded");
    await notificationPromise;
    Assert.equal(1, win.gNotificationBox.allNotifications.length);
    Assert.equal(
      "COMPULSORY_RESTART_SCHEDULED",
      win.gNotificationBox.allNotifications[0].getAttribute("value")
    );
  } finally {
    await popPrefs();
  }
});

/**
 * Tests that the felt-update-ready observer topic also triggers
 * the compulsory restart notification, for use when Felt handles updates.
 */
add_task(async function test_compulsoryRestartNotificationFromFelt() {
  await pushPrefs([prefName, JSON.stringify(prefValue)]);
  try {
    testingOnly_resetTasks();

    let win = Services.wm.getMostRecentBrowserWindow();
    for (let n of [...win.gNotificationBox.allNotifications]) {
      n.dismiss();
    }
    Assert.equal(0, win.gNotificationBox.allNotifications.length);
    const notificationPromise = BrowserTestUtils.waitForGlobalNotificationBar(
      win,
      "COMPULSORY_RESTART_SCHEDULED"
    );
    Services.obs.notifyObservers(null, "felt-update-ready");
    await notificationPromise;
    Assert.equal(1, win.gNotificationBox.allNotifications.length);
    Assert.equal(
      "COMPULSORY_RESTART_SCHEDULED",
      win.gNotificationBox.allNotifications[0].getAttribute("value")
    );
  } finally {
    testingOnly_resetTasks();
    await popPrefs();
  }
});
