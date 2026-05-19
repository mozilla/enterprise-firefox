/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(
  async function test_accessibility_sidebar_hidden_when_redesign_disabled() {
    await SpecialPowers.pushPrefEnv({
      set: [["browser.settings-redesign.enabled", false]],
    });
    await openPreferencesViaOpenPreferencesAPI("general", { leaveOpen: true });
    let doc = gBrowser.selectedBrowser.contentDocument;

    ok(
      !doc.getElementById("category-accessibility"),
      "Accessibility category is removed from DOM when settings redesign is disabled"
    );

    BrowserTestUtils.removeTab(gBrowser.selectedTab);
  }
);

add_task(
  async function test_accessibility_sidebar_visible_when_redesign_enabled() {
    await SpecialPowers.pushPrefEnv({
      set: [["browser.settings-redesign.enabled", true]],
    });
    await openPreferencesViaOpenPreferencesAPI("general", { leaveOpen: true });
    let doc = gBrowser.selectedBrowser.contentDocument;

    is_element_visible(
      doc.getElementById("category-accessibility"),
      "Accessibility category is visible when settings redesign is enabled"
    );

    BrowserTestUtils.removeTab(gBrowser.selectedTab);
  }
);

add_task(async function test_accessibility_pane_loads_setting_groups() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.settings-redesign.enabled", true]],
  });
  await openPreferencesViaOpenPreferencesAPI("accessibility", {
    leaveOpen: true,
  });
  let doc = gBrowser.selectedBrowser.contentDocument;

  await BrowserTestUtils.waitForMutationCondition(
    doc.getElementById("mainPrefPane"),
    { childList: true, subtree: true },
    () => doc.querySelector('setting-group[groupid="zoom"]')
  );

  for (let groupId of [
    "zoom",
    "fonts",
    "contrast",
    "keyboardAndScrolling",
    "motionAndLink",
  ]) {
    let group = doc.querySelector(`setting-group[groupid="${groupId}"]`);
    ok(group, `${groupId} setting-group exists`);
    is_element_visible(group, `${groupId} setting-group is visible`);
  }

  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

add_task(async function test_accessibility_pane_click_sidebar() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.settings-redesign.enabled", true]],
  });
  await openPreferencesViaOpenPreferencesAPI("general", { leaveOpen: true });
  let doc = gBrowser.selectedBrowser.contentDocument;
  let win = doc.documentGlobal;

  let paneLoaded = waitForPaneChange("accessibility");
  let categoryBtn = doc.getElementById("category-accessibility");
  categoryBtn.scrollIntoView();
  EventUtils.synthesizeMouseAtCenter(categoryBtn, {}, win);
  await paneLoaded;

  let zoomGroup = doc.querySelector('setting-group[groupid="zoom"]');
  ok(zoomGroup, "Zoom setting-group is present after clicking accessibility");

  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

add_task(async function test_pane_registration_no_errors() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.settings-redesign.enabled", true]],
  });
  await openPreferencesViaOpenPreferencesAPI("accessibility", {
    leaveOpen: true,
  });
  let doc = gBrowser.selectedBrowser.contentDocument;

  await BrowserTestUtils.waitForMutationCondition(
    doc.getElementById("mainPrefPane"),
    { childList: true, subtree: true },
    () => doc.querySelector('setting-group[groupid="zoom"]')
  );
  let firstGroup = doc.querySelector('setting-group[groupid="zoom"]');
  ok(
    firstGroup,
    "Accessibility pane loaded with setting-groups (no registration errors)"
  );

  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});
