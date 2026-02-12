/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { ERRORS } = ChromeUtils.importESModule(
  "chrome://browser/content/ipprotection/ipprotection-constants.mjs"
);
const { IPPNetworkUtils } = ChromeUtils.importESModule(
  "moz-src:///browser/components/ipprotection/IPPNetworkUtils.sys.mjs"
);

/**
 * Tests that the panel does not show the network error when opened while offline.
 * Error should only appear after attempting to activate the VPN.
 */
add_task(async function test_panel_no_error_when_opened_offline() {
  setupService({
    isSignedIn: true,
    isEnrolledAndEntitled: true,
    canEnroll: true,
    proxyPass: {
      status: 200,
      error: undefined,
      pass: makePass(),
    },
  });
  await IPPEnrollAndEntitleManager.refetchEntitlement();

  // Go offline before opening panel
  Services.io.offline = true;

  let content = await openPanel({
    isSignedOut: false,
    unauthenticated: false,
  });

  await content.updateComplete;

  Assert.ok(
    !content.state.error,
    "Network error should not be present when opened while offline"
  );
  Assert.ok(
    !content.statusBoxEl,
    "Status box should not be present when opened while offline"
  );

  // Should show normal status card with Turn On button
  let statusCard = content.statusCardEl;
  Assert.ok(statusCard, "Status card should be present");

  let turnOnButton = statusCard.actionButtonEl;
  Assert.ok(turnOnButton, "Turn on button should be present");

  // Cleanup - go back online
  Services.io.offline = false;

  await closePanel();
  cleanupService();
});

/**
 * Tests that the toolbar button icon updates when network goes offline,
 * even when VPN is not active.
 */
add_task(async function test_toolbar_button_icon_when_offline() {
  setupService({
    isSignedIn: true,
    isEnrolledAndEntitled: true,
    canEnroll: true,
    proxyPass: {
      status: 200,
      error: undefined,
      pass: makePass(),
    },
  });
  await IPPEnrollAndEntitleManager.refetchEntitlement();

  let button = document.getElementById(IPProtectionWidget.WIDGET_ID);
  Assert.ok(button, "Toolbar button should exist");

  // Initially should not be in error state
  Assert.ok(
    !button.classList.contains("ipprotection-error"),
    "Toolbar button should not show error initially"
  );

  let iconUpdatePromise = TestUtils.waitForCondition(
    () => button.classList.contains("ipprotection-error"),
    "Toolbar button should show error icon when offline"
  );

  // Go offline
  Services.io.offline = true;
  Services.obs.notifyObservers(null, "network:offline-status-changed");

  await iconUpdatePromise;

  Assert.ok(
    button.classList.contains("ipprotection-error"),
    "Toolbar button should show error icon even when VPN is off"
  );

  iconUpdatePromise = TestUtils.waitForCondition(
    () => !button.classList.contains("ipprotection-error"),
    "Toolbar button should clear error icon when back online"
  );

  // Back online
  Services.io.offline = false;
  Services.obs.notifyObservers(null, "network:offline-status-changed");

  await iconUpdatePromise;

  Assert.ok(
    !button.classList.contains("ipprotection-error"),
    "Toolbar button should clear error icon when back online"
  );

  cleanupService();
});

/**
 * Tests that network errors are caught when trying to activate VPN while offline.
 */
add_task(async function test_network_error_when_activating_offline() {
  setupService({
    isSignedIn: true,
    isEnrolledAndEntitled: true,
    canEnroll: true,
    proxyPass: {
      status: 200,
      error: undefined,
      pass: makePass(),
    },
  });
  await IPPEnrollAndEntitleManager.refetchEntitlement();

  // Stub alert manager to ensure we display it when a network error occurs
  const sandbox = sinon.createSandbox();
  let alertStub = sandbox.stub(IPProtectionAlertManager, "showErrorPrompts");

  // Go offline before opening panel
  Services.io.offline = true;

  let content = await openPanel();

  await content.updateComplete;

  let statusCard = content.statusCardEl;
  Assert.ok(statusCard, "Status card should be present");

  let turnOnButton = statusCard.actionButtonEl;
  Assert.ok(turnOnButton, "Turn on button should be present");

  // Wait for ERROR state when clicking Turn On while offline
  let errorStatePromise = BrowserTestUtils.waitForEvent(
    IPPProxyManager,
    "IPPProxyManager:StateChanged",
    false,
    () => IPPProxyManager.state === IPPProxyStates.ERROR
  );

  // Try to activate the VPN while offline
  turnOnButton.click();

  await errorStatePromise;

  Assert.equal(
    IPPProxyManager.state,
    IPPProxyStates.ERROR,
    "IPPProxyManager should be in ERROR state when trying to start while offline"
  );
  Assert.ok(
    IPPProxyManager.errors.includes(ERRORS.NETWORK),
    "Should have network-error"
  );
  Assert.ok(
    alertStub.calledOnce,
    "Alert should be shown when activation fails due to network"
  );

  await content.updateComplete;

  let statusBox = content.statusBoxEl;
  Assert.ok(statusBox, "Status box should be shown for error");
  Assert.equal(
    content.state.error,
    ERRORS.NETWORK,
    "Panel should show network error"
  );

  // Cleanup - go back online
  Services.io.offline = false;

  await closePanel();
  cleanupService();
  sandbox.restore();
});
