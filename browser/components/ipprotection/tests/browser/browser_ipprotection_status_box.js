/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { LINKS } = ChromeUtils.importESModule(
  "chrome://browser/content/ipprotection/ipprotection-constants.mjs"
);
const lazy = {};

const mockBandwidthUsage = {
  currentBandwidthUsage: 50,
  maxBandwidth: 150,
};

add_task(async function test_paused_content() {
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

  let content = await openPanel({
    paused: true,
    hasUpgraded: false,
    bandwidthUsage: mockBandwidthUsage,
  });

  let statusBox = content.statusBoxEl;
  Assert.ok(statusBox, "Status box should be shown when paused");

  let pausedTitle = statusBox.titleEl;
  let pausedDescription = statusBox.descriptionEl;
  let upgradeContent = content.upgradeEl;
  let upgradeDescription = upgradeContent.querySelector(
    "#upgrade-vpn-description"
  );
  let upgradeButton = upgradeContent.querySelector("#upgrade-vpn-button");

  Assert.ok(pausedTitle, "Paused title should be present");
  Assert.ok(pausedDescription, "Paused description should be present");
  Assert.ok(
    upgradeContent,
    "Upgrade content should be present when not upgraded"
  );
  Assert.ok(upgradeDescription, "Upgrade description should be present");
  Assert.ok(
    upgradeButton,
    "Upgrade button should be present when not upgraded"
  );
  Assert.ok(!content.statusCardEl, "Status card should be hidden when paused");

  let newTabPromise = BrowserTestUtils.waitForNewTab(
    gBrowser,
    LINKS.PRODUCT_URL + "#pricing"
  );
  let panelHiddenPromise = waitForPanelEvent(document, "popuphidden");
  upgradeButton.click();
  let newTab = await newTabPromise;
  await panelHiddenPromise;

  Assert.equal(
    gBrowser.selectedTab,
    newTab,
    "New tab is now open in a new foreground tab"
  );

  await setPanelState();
  BrowserTestUtils.removeTab(newTab);
  cleanupService();
});

add_task(async function test_paused_content_upgraded() {
  let content = await openPanel({
    isSignedOut: false,
    paused: true,
    hasUpgraded: true,
    bandwidthUsage: mockBandwidthUsage,
  });

  let statusBox = content.statusBoxEl;
  Assert.ok(statusBox, "Status box should be shown when paused");

  let pausedTitle = statusBox.titleEl;
  let pausedDescription = statusBox.descriptionEl;
  let upgradeContent = content.upgradeEl;

  Assert.ok(pausedTitle, "Paused title should be present");
  Assert.ok(pausedDescription, "Paused description should be present");
  Assert.ok(
    !upgradeContent,
    "Upgrade content should not be present when user has upgraded"
  );
  Assert.ok(!content.statusCardEl, "Status card should be hidden when paused");

  await setPanelState();
});
