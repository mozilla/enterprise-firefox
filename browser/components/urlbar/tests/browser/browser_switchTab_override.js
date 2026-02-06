/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This test ensures that overriding switch-to-tab correctly loads the page
 * rather than switching to it.
 */

"use strict";

const TEST_URL = `${TEST_BASE_URL}dummy_page.html`;

add_task(async function test_switchtab_override() {
  info("Opening first tab");
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, TEST_URL);

  info("Opening and selecting second tab");
  let secondTab = await BrowserTestUtils.openNewForegroundTab(gBrowser);

  info("Wait for autocomplete");
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: "dummy_page",
  });

  info("Select second autocomplete popup entry");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  let result = await UrlbarTestUtils.getDetailsOfResultAt(
    window,
    UrlbarTestUtils.getSelectedRowIndex(window)
  );
  Assert.equal(result.type, UrlbarUtils.RESULT_TYPE.TAB_SWITCH);

  // Check to see if the switchtab label is visible and
  // all other labels are hidden
  const allLabels = document.getElementById("urlbar-label-box").children;
  for (let label of allLabels) {
    if (label.id == "urlbar-label-switchtab") {
      Assert.ok(BrowserTestUtils.isVisible(label));
    } else {
      Assert.ok(BrowserTestUtils.isHidden(label));
    }
  }

  info("Override switch-to-tab");
  let deferred = Promise.withResolvers();
  // In case of failure this would switch tab.
  let onTabSelect = () => {
    deferred.reject(new Error("Should have overridden switch to tab"));
  };
  gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
  registerCleanupFunction(() => {
    gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
  });
  // Otherwise it would load the page.
  BrowserTestUtils.browserLoaded(secondTab.linkedBrowser).then(
    deferred.resolve
  );

  EventUtils.synthesizeKey("KEY_Shift", { type: "keydown" });

  // Checks that all labels are hidden when Shift is held down on the SwitchToTab result
  for (let label of allLabels) {
    Assert.ok(BrowserTestUtils.isHidden(label));
  }

  let attribute = "action-override";
  Assert.ok(
    gURLBar.view.panel.hasAttribute(attribute),
    "We should be overriding"
  );

  EventUtils.synthesizeKey("KEY_Enter");
  info(`gURLBar.value = ${gURLBar.value}`);
  await deferred.promise;

  // Blurring the urlbar should have cleared the override.
  Assert.ok(
    !gURLBar.view.panel.hasAttribute(attribute),
    "We should not be overriding anymore"
  );

  EventUtils.synthesizeKey("KEY_Shift", { type: "keyup" });
  await PlacesUtils.history.clear();
  gBrowser.removeTab(tab);
  gBrowser.removeTab(secondTab);
});

add_task(async function test_switchtab_override_scotch_bonnet() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.secondaryActions.switchToTab", true]],
  });

  info("Opening first tab");
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, TEST_URL);

  info("Opening and selecting second tab");
  let secondTab = await BrowserTestUtils.openNewForegroundTab(gBrowser);

  info("Wait for autocomplete");
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: "dummy_page",
  });

  info("Select second autocomplete popup entry");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  let result = await UrlbarTestUtils.getDetailsOfResultAt(
    window,
    UrlbarTestUtils.getSelectedRowIndex(window)
  );
  Assert.equal(result.type, UrlbarUtils.RESULT_TYPE.TAB_SWITCH);

  info("Check the current status");
  let actionButton = result.element.row.querySelector(
    ".urlbarView-action-btn[data-action=tabswitch]"
  );
  let urlLabel = result.element.url;
  Assert.ok(BrowserTestUtils.isVisible(actionButton));
  Assert.ok(BrowserTestUtils.isHidden(urlLabel));

  info("Enable action-override");
  EventUtils.synthesizeKey("KEY_Shift", { type: "keydown" });
  Assert.ok(BrowserTestUtils.isHidden(actionButton));
  Assert.ok(BrowserTestUtils.isVisible(urlLabel));

  info("Disable action-override");
  EventUtils.synthesizeKey("KEY_Shift", { type: "keyup" });
  Assert.ok(BrowserTestUtils.isVisible(actionButton));
  Assert.ok(BrowserTestUtils.isHidden(urlLabel));

  info("Cleanup");
  gBrowser.removeTab(tab);
  gBrowser.removeTab(secondTab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_switchtab_override_scotch_bonnet_for_split_view() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.secondaryActions.switchToTab", false]],
  });

  info("Opening first tab");
  let tab1 = await BrowserTestUtils.openNewForegroundTab(gBrowser, TEST_URL);
  let tab2 = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:opentabs"
  );

  info("Opening and selecting second tab");
  let tab3 = await BrowserTestUtils.openNewForegroundTab(gBrowser);

  gBrowser.addTabSplitView([tab2, tab3], { id: "1" });
  let tabbrowserTabs = document.getElementById("tabbrowser-tabs");
  await BrowserTestUtils.waitForMutationCondition(
    tabbrowserTabs,
    { childList: true },
    () => tabbrowserTabs.querySelectorAll("tab-split-view-wrapper").length === 1
  );

  info("Wait for autocomplete");
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: "dummy_page",
  });

  info("Select second autocomplete popup entry");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  let result = await UrlbarTestUtils.getDetailsOfResultAt(
    window,
    UrlbarTestUtils.getSelectedRowIndex(window)
  );
  Assert.equal(result.type, UrlbarUtils.RESULT_TYPE.TAB_SWITCH);

  info("Check the current status");
  let actionLabel = result.element.row.querySelector(".urlbarView-action");
  Assert.ok(BrowserTestUtils.isVisible(actionLabel));
  Assert.ok(actionLabel.textContent, "Move tab to Split View");

  info("Cleanup");
  gBrowser.removeTab(tab1);
  gBrowser.removeTab(tab2);
  gBrowser.removeTab(tab3);
  await SpecialPowers.popPrefEnv();
});
