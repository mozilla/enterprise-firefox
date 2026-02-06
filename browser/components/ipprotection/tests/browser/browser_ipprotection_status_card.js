/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { LINKS } = ChromeUtils.importESModule(
  "chrome://browser/content/ipprotection/ipprotection-constants.mjs"
);
const { IPPExceptionsManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/ipprotection/IPPExceptionsManager.sys.mjs"
);

const mockLocation = {
  name: "United States",
  code: "us",
};

const mockBandwidthUsage = {
  currentBandwidthUsage: 25,
  maxBandwidth: 50,
};

async function setupStatusCardTest() {
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
}

async function cleanupStatusCardTest() {
  cleanupService();
}

function checkLocationAndBandwidth(statusBoxEl, location, bandwidth) {
  const locationEl = statusBoxEl.shadowRoot
    .querySelector(`slot[name="location"]`)
    .assignedElements()[0];
  Assert.ok(
    BrowserTestUtils.isVisible(locationEl),
    "Location element should be present and visible"
  );
  Assert.equal(
    locationEl.textContent.trim(),
    location.name,
    "Location element should be showing correct location"
  );

  const bandwidthEl = statusBoxEl.shadowRoot
    .querySelector(`slot[name="bandwidth"]`)
    .assignedElements()[0];
  Assert.ok(
    BrowserTestUtils.isVisible(bandwidthEl),
    "bandwidth-usage should be present and visible"
  );
  Assert.equal(
    bandwidthEl.value,
    bandwidth.currentBandwidthUsage,
    `Bandwidth should have ${bandwidth.currentBandwidthUsage} GB used`
  );
  Assert.equal(
    bandwidthEl.bandwidthLeft,
    bandwidth.maxBandwidth - bandwidth.currentBandwidthUsage,
    `Bandwidth should have ${bandwidth.maxBandwidth - bandwidth.currentBandwidthUsage} GB left`
  );
  Assert.equal(
    bandwidthEl.max,
    bandwidth.maxBandwidth,
    `Bandwidth should have a max value of ${bandwidth.maxBandwidth}`
  );
}

/**
 * Tests the disconnected state UI.
 */
add_task(async function test_status_card_disconnected() {
  await setupStatusCardTest();

  let content = await openPanel({
    location: mockLocation,
    isProtectionEnabled: false,
    bandwidthUsage: mockBandwidthUsage,
  });

  Assert.ok(
    BrowserTestUtils.isVisible(content),
    "ipprotection content component should be present"
  );

  let statusCard = content.statusCardEl;
  Assert.ok(content.statusCardEl, "ipprotection-status-card should be present");

  let statusBoxEl = statusCard.statusBoxEl;
  Assert.ok(statusBoxEl, "Status box should be present");

  checkLocationAndBandwidth(statusBoxEl, mockLocation, mockBandwidthUsage);

  const turnOnButtonEl = statusCard.actionButtonEl;
  Assert.ok(turnOnButtonEl, "Button to turn on VPN should be present");

  await closePanel();
  await cleanupStatusCardTest();
});

/**
 * Tests the connected state UI.
 */
add_task(async function test_status_card_connected() {
  await setupStatusCardTest();

  let content = await openPanel({
    location: mockLocation,
    isProtectionEnabled: true,
    bandwidthUsage: mockBandwidthUsage,
  });

  Assert.ok(
    BrowserTestUtils.isVisible(content),
    "ipprotection content component should be present"
  );

  let statusCard = content.statusCardEl;
  Assert.ok(content.statusCardEl, "ipprotection-status-card should be present");

  let statusBoxEl = statusCard.statusBoxEl;
  Assert.ok(statusBoxEl, "Status box should be present");

  checkLocationAndBandwidth(statusBoxEl, mockLocation, mockBandwidthUsage);

  const turnOffVPNButtonEl = statusCard.actionButtonEl;
  Assert.ok(turnOffVPNButtonEl, "Button to turn off VPN should be present");

  await closePanel();
  await cleanupStatusCardTest();
});

/**
 * Tests that the correct IPProtection events are dispatched when
 * we enable or disable VPN protection.
 */
add_task(async function test_ipprotection_events_on_toggle() {
  // These events are different from the ones sent by
  // ipprotection-status-card. The prefixed "IPProtection:" events
  // actually change the connection state in the service when dispatched.
  // If the IPProtection events are sent, then we know that the status-card
  // events worked.
  const userEnableEventName = "IPProtection:UserEnable";
  const userDisableEventName = "IPProtection:UserDisable";

  // Reset service state.
  cleanupService();
  IPProtectionService.updateState();

  await setupStatusCardTest();

  let content = await openPanel({
    location: mockLocation,
    isProtectionEnabled: false,
    bandwidthUsage: mockBandwidthUsage,
  });

  Assert.ok(
    BrowserTestUtils.isVisible(content),
    "ipprotection content component should be present"
  );

  let statusCard = content.statusCardEl;
  Assert.ok(content.statusCardEl, "ipprotection-status-card should be present");

  let statusBoxEl = statusCard.statusBoxEl;
  Assert.ok(statusBoxEl, "Status box should be present");

  // Now click "Turn on"
  let turnOnVPNButtonEl = statusCard.actionButtonEl;
  Assert.ok(turnOnVPNButtonEl, "Button to turn on VPN should be present");

  let startedProxyPromise = BrowserTestUtils.waitForEvent(
    IPPProxyManager,
    "IPPProxyManager:StateChanged",
    false,
    () => !!IPPProxyManager.activatedAt
  );
  let enableEventPromise = BrowserTestUtils.waitForEvent(
    window,
    userEnableEventName
  );

  turnOnVPNButtonEl.click();

  await Promise.all([startedProxyPromise, enableEventPromise]);

  Assert.ok(
    true,
    "Enable event and proxy started event were found after clicking the toggle"
  );

  let userEnabledPref = Services.prefs.getBoolPref(
    "browser.ipProtection.userEnabled",
    false
  );
  Assert.equal(userEnabledPref, true, "userEnabled pref should be set to true");

  // Now click "Turn off"
  let turnOffVPNButtonEl = statusCard.actionButtonEl;
  Assert.ok(turnOffVPNButtonEl, "Button to turn off VPN should be present");

  let stoppedProxyPromise = BrowserTestUtils.waitForEvent(
    IPPProxyManager,
    "IPPProxyManager:StateChanged",
    false,
    () => !IPPProxyManager.activatedAt
  );
  let disableEventPromise = BrowserTestUtils.waitForEvent(
    window,
    userDisableEventName
  );

  turnOffVPNButtonEl.click();

  await Promise.all([stoppedProxyPromise, disableEventPromise]);
  Assert.ok(
    true,
    "Disable event and stopped proxy event were found after clicking the toggle"
  );

  userEnabledPref = Services.prefs.getBoolPref(
    "browser.ipProtection.userEnabled",
    true
  );
  Assert.equal(
    userEnabledPref,
    false,
    "userEnabled pref should be set to false"
  );

  await closePanel();
  await cleanupStatusCardTest();
});

/**
 * Tests the excluded site state UI.
 */
add_task(async function test_status_card_excluded() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(IPPExceptionsManager, "hasExclusion").returns(true);

  await setupStatusCardTest();

  let content = await openPanel({
    location: mockLocation,
    isProtectionEnabled: true,
    bandwidthUsage: mockBandwidthUsage,
  });

  Assert.ok(
    BrowserTestUtils.isVisible(content),
    "ipprotection content component should be present"
  );

  let statusCard = content.statusCardEl;
  Assert.ok(content.statusCardEl, "ipprotection-status-card should be present");

  let statusBoxEl = statusCard.statusBoxEl;
  Assert.ok(statusBoxEl, "Status box should be present");

  Assert.equal(
    statusBoxEl.type,
    "excluded",
    "Status box should have excluded type"
  );

  checkLocationAndBandwidth(statusBoxEl, mockLocation, mockBandwidthUsage);

  const turnOffVPNButtonEl = statusCard.actionButtonEl;
  Assert.ok(turnOffVPNButtonEl, "Button to turn off VPN should be present");

  await closePanel();
  await cleanupStatusCardTest();
  sandbox.restore();
});

/**
 * Tests the connecting state UI.
 */
add_task(async function test_status_card_connecting() {
  await setupStatusCardTest();

  let content = await openPanel({
    location: mockLocation,
    isProtectionEnabled: true,
    bandwidthUsage: mockBandwidthUsage,
    isActivating: true,
  });

  Assert.ok(
    BrowserTestUtils.isVisible(content),
    "ipprotection content component should be present"
  );

  let statusCard = content.statusCardEl;
  Assert.ok(content.statusCardEl, "ipprotection-status-card should be present");

  let statusBoxEl = statusCard.statusBoxEl;
  Assert.ok(statusBoxEl, "Status box should be present");

  Assert.equal(
    statusBoxEl.type,
    "connecting",
    "Status box should have connecting type"
  );

  checkLocationAndBandwidth(statusBoxEl, mockLocation, mockBandwidthUsage);

  const button = statusCard.actionButtonEl;
  Assert.ok(
    button?.disabled,
    "Button in connecting state should be present and disabled"
  );

  await closePanel();
  await cleanupStatusCardTest();
});
