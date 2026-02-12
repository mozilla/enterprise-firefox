/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * Tests the warning message bar triggered by bandwidth threshold preference
 */
add_task(async function test_warning_message() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.ipProtection.bandwidth.enabled", true],
      ["browser.ipProtection.bandwidthThreshold", 0],
    ],
  });

  // Start with no bandwidth usage
  let content = await openPanel({
    isSignedOut: false,
    error: "",
    bandwidthUsage: {
      currentBandwidthUsage: 0,
      maxBandwidth: 50,
    },
  });

  let messageBar = content.shadowRoot.querySelector("ipprotection-message-bar");

  Assert.ok(!messageBar, "Message bar should not be present initially");

  let messageBarLoadedPromise = BrowserTestUtils.waitForMutationCondition(
    content.shadowRoot,
    { childList: true, subtree: true },
    () => content.shadowRoot.querySelector("ipprotection-message-bar")
  );

  // Simulate bandwidth usage increasing to 75% (37.5 GB used, 12.5 GB remaining)
  await setPanelState({
    isSignedOut: false,
    error: "",
    bandwidthUsage: {
      remaining: 12.5,
      max: 50,
    },
  });

  // Set threshold to 75% to trigger warning
  await SpecialPowers.pushPrefEnv({
    set: [["browser.ipProtection.bandwidthThreshold", 75]],
  });

  await messageBarLoadedPromise;

  messageBar = content.shadowRoot.querySelector("ipprotection-message-bar");

  Assert.ok(messageBar, "Message bar should be present after threshold change");
  Assert.ok(
    messageBar.mozMessageBarEl,
    "Wrapped moz-message-bar should be present"
  );
  Assert.equal(messageBar.type, "warning", "Message bar should be warning");
  Assert.equal(
    messageBar.messageId,
    "ipprotection-message-bandwidth-warning",
    "Warning message id should match"
  );

  // Verify bandwidth data is passed to the message bar
  Assert.ok(
    messageBar.bandwidthUsage,
    "Bandwidth usage data should be passed to message bar"
  );
  Assert.equal(
    messageBar.bandwidthUsage.remaining,
    12.5,
    "Current bandwidth remaining should match (37.5 GB used at 75% threshold)"
  );
  Assert.equal(
    messageBar.bandwidthUsage.max,
    50,
    "Max bandwidth should match (50 GB limit)"
  );

  // Dismiss the 75% warning
  let closeButton = messageBar.mozMessageBarEl.closeButton;
  Assert.ok(closeButton, "Message bar should have close button");

  let dismissEvent = BrowserTestUtils.waitForEvent(
    document,
    messageBar.DISMISS_EVENT
  );
  let messageBarUnloadedPromise = BrowserTestUtils.waitForMutationCondition(
    content.shadowRoot,
    { childList: true, subtree: true },
    () => !content.shadowRoot.querySelector("ipprotection-message-bar")
  );

  closeButton.click();

  await dismissEvent;
  await messageBarUnloadedPromise;

  Assert.ok(
    !content.shadowRoot.querySelector("ipprotection-message-bar"),
    "Message bar should be dismissed after clicking close button"
  );

  await closePanel();

  // Simulate bandwidth usage increasing to 90% (45 GB used, 5 GB remaining)
  await SpecialPowers.pushPrefEnv({
    set: [["browser.ipProtection.bandwidthThreshold", 90]],
  });
  // Simulate bandwidth usage increasing to 90% (45 GB used, 5 GB remaining)
  content = await openPanel({
    isSignedOut: false,
    error: "",
    bandwidthUsage: {
      remaining: 5,
      max: 50,
    },
  });

  messageBarLoadedPromise = BrowserTestUtils.waitForMutationCondition(
    content.shadowRoot,
    { childList: true, subtree: true },
    () => content.shadowRoot.querySelector("ipprotection-message-bar")
  );

  // The 90% warning should appear
  await messageBarLoadedPromise;

  messageBar = content.shadowRoot.querySelector("ipprotection-message-bar");

  Assert.ok(
    messageBar,
    "Message bar should reappear at 90% threshold after 75% was dismissed"
  );
  Assert.equal(messageBar.type, "warning", "Message bar should be warning");
  Assert.equal(
    messageBar.messageId,
    "ipprotection-message-bandwidth-warning",
    "Warning message id should match"
  );

  // Verify updated bandwidth data
  Assert.equal(
    messageBar.bandwidthUsage.remaining,
    5,
    "Current bandwidth usage should be updated (45 GB used at 90% threshold)"
  );
  Assert.equal(
    messageBar.bandwidthUsage.max,
    50,
    "Max bandwidth should match (50 GB limit)"
  );

  dismissEvent = BrowserTestUtils.waitForEvent(
    document,
    messageBar.DISMISS_EVENT
  );
  messageBarUnloadedPromise = BrowserTestUtils.waitForMutationCondition(
    content.shadowRoot,
    { childList: true, subtree: true },
    () => !content.shadowRoot.querySelector("ipprotection-message-bar")
  );
  closeButton = messageBar.mozMessageBarEl.closeButton;
  closeButton.click();

  await dismissEvent;
  await messageBarUnloadedPromise;

  await closePanel();
  await SpecialPowers.popPrefEnv();
});

/**
 * Tests that dismissing the message bar dispatches the expected events and
 * removes it from the DOM.
 */
add_task(async function test_dismiss() {
  let content = await openPanel({
    isSignedOut: false,
    error: "",
    bandwidthWarning: false,
  });

  let messageBar = content.shadowRoot.querySelector("ipprotection-message-bar");

  Assert.ok(!messageBar, "Message bar should not be present");

  let messageBarLoadedPromise = BrowserTestUtils.waitForMutationCondition(
    content.shadowRoot,
    { childList: true, subtree: true },
    () => content.shadowRoot.querySelector("ipprotection-message-bar")
  );

  // Use bandwidth warning to test message bar dismiss functionality
  await setPanelState({
    isSignedOut: false,
    error: "",
    bandwidthWarning: true,
  });
  await messageBarLoadedPromise;

  messageBar = content.shadowRoot.querySelector("ipprotection-message-bar");

  Assert.ok(messageBar, "Message bar should be present");
  Assert.ok(
    messageBar.mozMessageBarEl,
    "Wrapped moz-message-bar should be present"
  );

  let closeButton = messageBar.mozMessageBarEl.closeButton;

  Assert.ok(closeButton, "Message bar should have close button");

  let dismissEvent = BrowserTestUtils.waitForEvent(
    document,
    messageBar.DISMISS_EVENT
  );
  let messageBarUnloadedPromise = BrowserTestUtils.waitForMutationCondition(
    content.shadowRoot,
    { childList: true, subtree: true },
    () => !content.shadowRoot.querySelector("ipprotection-message-bar")
  );

  closeButton.click();

  await dismissEvent;
  Assert.ok(true, "Dismiss event was dispatched");

  await messageBarUnloadedPromise;
  Assert.ok(true, "Message bar should be not be present");

  await closePanel();
});
