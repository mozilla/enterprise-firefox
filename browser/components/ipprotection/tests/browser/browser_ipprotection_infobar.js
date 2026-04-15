/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { IPProtectionInfobarManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/ipprotection/IPProtectionInfobarManager.sys.mjs"
);
const { BANDWIDTH } = ChromeUtils.importESModule(
  "chrome://browser/content/ipprotection/ipprotection-constants.mjs"
);

const BANDWIDTH_WARNING_DISMISSED_PREF =
  "browser.ipProtection.bandwidthWarningDismissedThreshold";

function dispatchUsageEvent(remainingPercent) {
  // Use realistic byte values: 50 GB max bandwidth
  const maxBytes = BigInt(BANDWIDTH.MAX_IN_GB) * BigInt(BANDWIDTH.BYTES_IN_GB);
  const remainingBytes = BigInt(
    Math.floor(Number(maxBytes) * remainingPercent)
  );

  IPPProxyManager.dispatchEvent(
    new CustomEvent("IPPProxyManager:UsageChanged", {
      bubbles: true,
      composed: true,
      detail: {
        usage: new ProxyUsage(maxBytes, remainingBytes, Temporal.Now.instant()),
      },
    })
  );
}

DEFAULT_EXPERIMENT = null;

const REGEX_DECIMAL = /^\d+\.\d$/;
const REGEX_WHOLE_NUMBER = /^\d+$/;

add_task(async function test_75_percent_notification() {
  IPProtectionInfobarManager.init();

  dispatchUsageEvent(0.2);

  await TestUtils.waitForCondition(
    () =>
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-75"
      ),
    "Wait for 75% notification to appear"
  );

  const notification = window.gNotificationBox.getNotificationWithValue(
    "ip-protection-bandwidth-warning-75"
  );

  Assert.ok(notification, "75% notification exists");
  Assert.equal(
    notification.priority,
    window.gNotificationBox.PRIORITY_WARNING_HIGH,
    "Notification has high warning priority"
  );
  Assert.ok(
    REGEX_DECIMAL.test(notification.messageL10nArgs.usageLeft),
    "75% notification shows GB with one decimal place"
  );

  window.gNotificationBox.removeNotification(notification);
  IPProtectionInfobarManager.uninit();
});

add_task(async function test_90_percent_notification() {
  IPProtectionInfobarManager.init();

  dispatchUsageEvent(0.08);

  await TestUtils.waitForCondition(
    () =>
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-90"
      ),
    "Wait for 90% notification to appear"
  );

  const notification = window.gNotificationBox.getNotificationWithValue(
    "ip-protection-bandwidth-warning-90"
  );

  Assert.ok(notification, "90% notification exists");
  Assert.equal(
    notification.priority,
    window.gNotificationBox.PRIORITY_WARNING_HIGH,
    "Notification has high warning priority"
  );
  Assert.ok(
    REGEX_WHOLE_NUMBER.test(notification.messageL10nArgs.usageLeft),
    "90% notification shows GB rounded to whole number"
  );

  window.gNotificationBox.removeNotification(notification);
  IPProtectionInfobarManager.uninit();
});

add_task(async function test_90_percent_notification_mb() {
  IPProtectionInfobarManager.init();

  dispatchUsageEvent(0.01);

  await TestUtils.waitForCondition(
    () =>
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-90"
      ),
    "Wait for 90% MB notification to appear"
  );

  const notification = window.gNotificationBox.getNotificationWithValue(
    "ip-protection-bandwidth-warning-90"
  );

  Assert.ok(notification, "90% MB notification exists");
  Assert.equal(
    notification.priority,
    window.gNotificationBox.PRIORITY_WARNING_HIGH,
    "Notification has high warning priority"
  );
  Assert.ok(
    REGEX_WHOLE_NUMBER.test(notification.messageL10nArgs.usageLeft),
    "90% MB notification shows a raw number in MB"
  );

  window.gNotificationBox.removeNotification(notification);
  IPProtectionInfobarManager.uninit();
});

add_task(async function test_no_notification_above_25_percent() {
  IPProtectionInfobarManager.init();

  dispatchUsageEvent(0.5);

  await TestUtils.waitForTick();

  const notification75 = window.gNotificationBox.getNotificationWithValue(
    "ip-protection-bandwidth-warning-75"
  );
  const notification90 = window.gNotificationBox.getNotificationWithValue(
    "ip-protection-bandwidth-warning-90"
  );

  Assert.equal(notification75, null, "No 75% notification when above 25%");
  Assert.equal(notification90, null, "No 90% notification when above 25%");

  IPProtectionInfobarManager.uninit();
});

add_task(async function test_no_duplicate_notifications() {
  IPProtectionInfobarManager.init();

  dispatchUsageEvent(0.15);

  await TestUtils.waitForCondition(
    () =>
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-75"
      ),
    "Wait for first 75% notification to appear"
  );

  const firstNotification = window.gNotificationBox.getNotificationWithValue(
    "ip-protection-bandwidth-warning-75"
  );
  Assert.ok(firstNotification, "First 75% notification exists");
  Assert.ok(
    REGEX_DECIMAL.test(firstNotification.messageL10nArgs.usageLeft),
    "First 75% notification shows GB with one decimal place"
  );

  dispatchUsageEvent(0.15);
  await TestUtils.waitForTick();

  const allNotifications = window.gNotificationBox.allNotifications;
  const warningNotifications = allNotifications.filter(n =>
    n.getAttribute("value").startsWith("ip-protection-bandwidth-warning")
  );

  Assert.equal(
    warningNotifications.length,
    1,
    "Only one notification exists after multiple events"
  );

  window.gNotificationBox.removeNotification(firstNotification);
  IPProtectionInfobarManager.uninit();
});

add_task(async function test_90_percent_overrides_75_percent() {
  IPProtectionInfobarManager.init();

  dispatchUsageEvent(0.05);

  await TestUtils.waitForCondition(
    () =>
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-90"
      ),
    "Wait for 90% notification to appear"
  );

  const notification90 = window.gNotificationBox.getNotificationWithValue(
    "ip-protection-bandwidth-warning-90"
  );
  const notification75 = window.gNotificationBox.getNotificationWithValue(
    "ip-protection-bandwidth-warning-75"
  );

  Assert.ok(notification90, "90% notification exists");
  Assert.ok(
    REGEX_WHOLE_NUMBER.test(notification90.messageL10nArgs.usageLeft),
    "90% notification shows GB rounded to whole number"
  );
  Assert.equal(notification75, null, "75% notification does not exist");

  window.gNotificationBox.removeNotification(notification90);
  IPProtectionInfobarManager.uninit();
});

add_task(async function test_remove_infobar_after_sign_out() {
  setupService({ isSignedIn: true, isEnrolledAndEntitled: true });
  IPProtectionService.updateState();

  IPProtectionInfobarManager.init();

  dispatchUsageEvent(0.2);

  await TestUtils.waitForCondition(
    () =>
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-75"
      ),
    "Wait for 75% notification to appear"
  );

  Assert.ok(
    window.gNotificationBox.getNotificationWithValue(
      "ip-protection-bandwidth-warning-75"
    ),
    "75% notification should be present before sign out"
  );

  setupService({ isSignedIn: false });
  IPProtectionService.updateState();

  await TestUtils.waitForCondition(
    () =>
      !window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-75"
      ),
    "Wait for 75% notification to be removed after sign out"
  );

  Assert.ok(
    !window.gNotificationBox.getNotificationWithValue(
      "ip-protection-bandwidth-warning-75"
    ),
    "75% notification should be removed after sign out"
  );

  IPProtectionInfobarManager.uninit();
  cleanupService();
});

add_task(async function test_hide_infobars_at_zero_remaining() {
  IPProtectionInfobarManager.init();

  dispatchUsageEvent(0.08);

  await TestUtils.waitForCondition(
    () =>
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-90"
      ),
    "Wait for 90% notification to appear"
  );

  Assert.ok(
    window.gNotificationBox.getNotificationWithValue(
      "ip-protection-bandwidth-warning-90"
    ),
    "90% notification should be present before bandwidth is exhausted"
  );

  dispatchUsageEvent(0);

  await TestUtils.waitForCondition(
    () =>
      !window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-90"
      ),
    "Wait for 90% notification to be removed when bandwidth is exhausted"
  );

  Assert.equal(
    window.gNotificationBox.getNotificationWithValue(
      "ip-protection-bandwidth-warning-90"
    ),
    null,
    "90% notification should be removed when bandwidth is exhausted"
  );
  Assert.equal(
    window.gNotificationBox.getNotificationWithValue(
      "ip-protection-bandwidth-warning-75"
    ),
    null,
    "75% notification should not be present when bandwidth is exhausted"
  );

  IPProtectionInfobarManager.uninit();
});

add_task(
  async function test_dismiss_infobar_when_usage_resets_above_25_percent() {
    IPProtectionInfobarManager.init();

    dispatchUsageEvent(0.08);

    await TestUtils.waitForCondition(
      () =>
        window.gNotificationBox.getNotificationWithValue(
          "ip-protection-bandwidth-warning-90"
        ),
      "Wait for 90% notification to appear"
    );

    Assert.ok(
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-90"
      ),
      "90% notification should be present before bandwidth resets"
    );

    dispatchUsageEvent(1);

    await TestUtils.waitForCondition(
      () =>
        !window.gNotificationBox.getNotificationWithValue(
          "ip-protection-bandwidth-warning-90"
        ),
      "Wait for 90% notification to be dismissed after usage resets"
    );

    Assert.equal(
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-90"
      ),
      null,
      "90% notification should be dismissed"
    );

    IPProtectionInfobarManager.uninit();
  }
);

add_task(async function test_dismissed_75_stays_dismissed() {
  Services.prefs.setIntPref(BANDWIDTH_WARNING_DISMISSED_PREF, 0);
  IPProtectionInfobarManager.init();

  dispatchUsageEvent(0.2);

  await TestUtils.waitForCondition(
    () =>
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-75"
      ),
    "Wait for 75% notification to appear"
  );

  window.gNotificationBox
    .getNotificationWithValue("ip-protection-bandwidth-warning-75")
    .dismiss();

  await TestUtils.waitForCondition(
    () =>
      !window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-75"
      ),
    "Wait for 75% notification to be removed after dismiss"
  );

  Assert.equal(
    Services.prefs.getIntPref(BANDWIDTH_WARNING_DISMISSED_PREF, 0),
    75,
    "Dismissed pref is set to 75 after dismissal"
  );

  dispatchUsageEvent(0.2);
  await TestUtils.waitForTick();

  Assert.equal(
    window.gNotificationBox.getNotificationWithValue(
      "ip-protection-bandwidth-warning-75"
    ),
    null,
    "75% notification does not reappear after being dismissed"
  );

  Services.prefs.clearUserPref(BANDWIDTH_WARNING_DISMISSED_PREF);
  IPProtectionInfobarManager.uninit();
});

add_task(async function test_dismissed_75_still_allows_90() {
  Services.prefs.setIntPref(BANDWIDTH_WARNING_DISMISSED_PREF, 0);
  IPProtectionInfobarManager.init();

  dispatchUsageEvent(0.2);

  await TestUtils.waitForCondition(
    () =>
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-75"
      ),
    "Wait for 75% notification to appear"
  );

  window.gNotificationBox
    .getNotificationWithValue("ip-protection-bandwidth-warning-75")
    .dismiss();

  await TestUtils.waitForCondition(
    () =>
      !window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-75"
      ),
    "Wait for 75% notification to be removed after dismiss"
  );

  dispatchUsageEvent(0.05);

  await TestUtils.waitForCondition(
    () =>
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-90"
      ),
    "Wait for 90% notification to appear"
  );

  Assert.ok(
    window.gNotificationBox.getNotificationWithValue(
      "ip-protection-bandwidth-warning-90"
    ),
    "90% notification appears even after 75% was dismissed"
  );

  window.gNotificationBox.removeNotification(
    window.gNotificationBox.getNotificationWithValue(
      "ip-protection-bandwidth-warning-90"
    )
  );
  Services.prefs.clearUserPref(BANDWIDTH_WARNING_DISMISSED_PREF);
  IPProtectionInfobarManager.uninit();
});

add_task(async function test_dismissed_90_stays_dismissed() {
  Services.prefs.setIntPref(BANDWIDTH_WARNING_DISMISSED_PREF, 0);
  IPProtectionInfobarManager.init();

  dispatchUsageEvent(0.05);

  await TestUtils.waitForCondition(
    () =>
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-90"
      ),
    "Wait for 90% notification to appear"
  );

  window.gNotificationBox
    .getNotificationWithValue("ip-protection-bandwidth-warning-90")
    .dismiss();

  await TestUtils.waitForCondition(
    () =>
      !window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-90"
      ),
    "Wait for 90% notification to be removed after dismiss"
  );

  Assert.equal(
    Services.prefs.getIntPref(BANDWIDTH_WARNING_DISMISSED_PREF, 0),
    90,
    "Dismissed pref is set to 90 after dismissal"
  );

  dispatchUsageEvent(0.05);
  await TestUtils.waitForTick();

  Assert.equal(
    window.gNotificationBox.getNotificationWithValue(
      "ip-protection-bandwidth-warning-90"
    ),
    null,
    "90% notification does not reappear after being dismissed"
  );

  Services.prefs.clearUserPref(BANDWIDTH_WARNING_DISMISSED_PREF);
  IPProtectionInfobarManager.uninit();
});

add_task(async function test_bandwidth_reset_clears_dismissed_state() {
  Services.prefs.setIntPref(BANDWIDTH_WARNING_DISMISSED_PREF, 0);
  IPProtectionInfobarManager.init();

  dispatchUsageEvent(0.2);

  await TestUtils.waitForCondition(
    () =>
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-75"
      ),
    "Wait for 75% notification to appear"
  );

  window.gNotificationBox
    .getNotificationWithValue("ip-protection-bandwidth-warning-75")
    .dismiss();

  await TestUtils.waitForCondition(
    () =>
      !window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-75"
      ),
    "Wait for 75% notification to be removed after dismiss"
  );

  Assert.equal(
    Services.prefs.getIntPref(BANDWIDTH_WARNING_DISMISSED_PREF, 0),
    75,
    "Dismissed pref is 75 after dismissal"
  );

  dispatchUsageEvent(1);
  await TestUtils.waitForTick();

  Assert.equal(
    Services.prefs.getIntPref(BANDWIDTH_WARNING_DISMISSED_PREF, 0),
    0,
    "Dismissed pref is reset to 0 after bandwidth resets"
  );

  dispatchUsageEvent(0.2);

  await TestUtils.waitForCondition(
    () =>
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-75"
      ),
    "Wait for 75% notification to reappear after bandwidth reset"
  );

  Assert.ok(
    window.gNotificationBox.getNotificationWithValue(
      "ip-protection-bandwidth-warning-75"
    ),
    "75% notification reappears after bandwidth resets"
  );

  window.gNotificationBox.removeNotification(
    window.gNotificationBox.getNotificationWithValue(
      "ip-protection-bandwidth-warning-75"
    )
  );
  Services.prefs.clearUserPref(BANDWIDTH_WARNING_DISMISSED_PREF);
  IPProtectionInfobarManager.uninit();
});

add_task(async function test_dismissed_state_persists_through_sign_out() {
  Services.prefs.setIntPref(BANDWIDTH_WARNING_DISMISSED_PREF, 0);
  setupService({ isSignedIn: true, isEnrolledAndEntitled: true });
  IPProtectionService.updateState();

  IPProtectionInfobarManager.init();

  dispatchUsageEvent(0.2);

  await TestUtils.waitForCondition(
    () =>
      window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-75"
      ),
    "Wait for 75% notification to appear"
  );

  window.gNotificationBox
    .getNotificationWithValue("ip-protection-bandwidth-warning-75")
    .dismiss();

  await TestUtils.waitForCondition(
    () =>
      !window.gNotificationBox.getNotificationWithValue(
        "ip-protection-bandwidth-warning-75"
      ),
    "Wait for 75% notification to be removed after dismiss"
  );

  setupService({ isSignedIn: false });
  IPProtectionService.updateState();
  await TestUtils.waitForTick();

  setupService({ isSignedIn: true, isEnrolledAndEntitled: true });
  IPProtectionService.updateState();

  dispatchUsageEvent(0.2);
  await TestUtils.waitForTick();

  Assert.equal(
    window.gNotificationBox.getNotificationWithValue(
      "ip-protection-bandwidth-warning-75"
    ),
    null,
    "75% notification stays dismissed after sign out and back in"
  );
  Assert.equal(
    Services.prefs.getIntPref(BANDWIDTH_WARNING_DISMISSED_PREF, 0),
    75,
    "Dismissed pref persists through sign out"
  );

  Services.prefs.clearUserPref(BANDWIDTH_WARNING_DISMISSED_PREF);
  IPProtectionInfobarManager.uninit();
  cleanupService();
});

add_task(async function test_handles_missing_usage_data() {
  IPProtectionInfobarManager.init();

  IPPProxyManager.dispatchEvent(
    new CustomEvent("IPPProxyManager:UsageChanged", {
      bubbles: true,
      composed: true,
      detail: {
        usage: null,
      },
    })
  );

  await TestUtils.waitForTick();

  const notification75 = window.gNotificationBox.getNotificationWithValue(
    "ip-protection-bandwidth-warning-75"
  );
  const notification90 = window.gNotificationBox.getNotificationWithValue(
    "ip-protection-bandwidth-warning-90"
  );

  Assert.equal(
    notification75,
    null,
    "No 75% notification with missing usage data"
  );
  Assert.equal(
    notification90,
    null,
    "No 90% notification with missing usage data"
  );

  IPProtectionInfobarManager.uninit();
});
