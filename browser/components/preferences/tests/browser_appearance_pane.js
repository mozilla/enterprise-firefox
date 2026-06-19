/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(
  async function test_appearance_sidebar_visible_when_redesign_enabled() {
    let tab = await openPrefsTab("appearance");
    let doc = tab.linkedBrowser.contentDocument;

    is_element_visible(
      doc.getElementById("category-appearance"),
      "Appearance category is visible when settings redesign is enabled"
    );

    await BrowserTestUtils.removeTab(tab);
  }
);

add_task(async function test_appearance_pane_loads_setting_groups() {
  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;

  await BrowserTestUtils.waitForMutationCondition(
    doc.getElementById("mainPrefPane"),
    { childList: true, subtree: true },
    () => doc.querySelector('setting-group[groupid="appearance"]')
  );

  for (let groupId of ["appearance", "browserTheme", "relatedSettings"]) {
    let group = doc.querySelector(`setting-group[groupid="${groupId}"]`);
    ok(group, `${groupId} setting-group exists`);
    is_element_visible(group, `${groupId} setting-group is visible`);
  }

  await BrowserTestUtils.removeTab(tab);
});

add_task(async function test_appearance_pane_click_sidebar() {
  let tab = await openPrefsTab("");
  let doc = tab.linkedBrowser.contentDocument;

  let navButton = doc.getElementById("category-appearance");
  await TestUtils.waitForCondition(
    () => navButton?.buttonEl,
    "Wait for appearance nav button to render"
  );

  let paneLoaded = waitForPaneChange("appearance");
  synthesizeClick(navButton);
  await paneLoaded;

  await BrowserTestUtils.waitForMutationCondition(
    doc.getElementById("mainPrefPane"),
    { childList: true, subtree: true },
    () => doc.querySelector('setting-group[groupid="appearance"]')
  );
  ok(
    doc.querySelector('setting-group[groupid="appearance"]'),
    "Appearance setting-group is present after clicking appearance nav button"
  );

  await BrowserTestUtils.removeTab(tab);
});

add_task(async function test_related_settings_accessibility_link_navigates() {
  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;

  await BrowserTestUtils.waitForMutationCondition(
    doc.getElementById("mainPrefPane"),
    { childList: true, subtree: true },
    () => doc.querySelector('setting-group[groupid="relatedSettings"]')
  );

  let paneLoaded = waitForPaneChange("accessibility");
  synthesizeClick(getSettingControl("related-settings-accessibility-link"));
  await paneLoaded;

  await BrowserTestUtils.removeTab(tab);
});

add_task(async function test_related_settings_home_link_navigates() {
  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;

  await BrowserTestUtils.waitForMutationCondition(
    doc.getElementById("mainPrefPane"),
    { childList: true, subtree: true },
    () => doc.querySelector('setting-group[groupid="relatedSettings"]')
  );

  let paneLoaded = waitForPaneChange("home");
  synthesizeClick(getSettingControl("related-settings-home-link"));
  await paneLoaded;

  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

add_task(async function test_related_settings_tabs_browsing_link_navigates() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.settings-redesign.enabled", true]],
  });
  await openPreferencesViaOpenPreferencesAPI("appearance", {
    leaveOpen: true,
  });
  let doc = gBrowser.selectedBrowser.contentDocument;

  await BrowserTestUtils.waitForMutationCondition(
    doc.getElementById("mainPrefPane"),
    { childList: true, subtree: true },
    () => doc.querySelector('setting-group[groupid="relatedSettings"]')
  );

  let paneLoaded = waitForPaneChange("tabsBrowsing");
  synthesizeClick(getSettingControl("related-settings-tabs-browsing-link"));
  await paneLoaded;

  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

async function withWindowDensityPane(callback) {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.nova.enabled", true]],
  });
  // browser.uidensity is a sticky pref, so any user value set during the test
  // outlives pushPrefEnv. Restore the default (no user value, i.e. automatic)
  // when we're done.
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref("browser.uidensity")
  );

  let tab = await openPrefsTab("appearance");
  let win = tab.linkedBrowser.contentWindow;
  let doc = win.document;

  await BrowserTestUtils.waitForMutationCondition(
    doc.getElementById("mainPrefPane"),
    { childList: true, subtree: true },
    () => doc.querySelector('setting-group[groupid="windowDensity"]')
  );

  try {
    await callback({ tab, win, doc });
  } finally {
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function test_window_density_group_visible_with_nova() {
  await withWindowDensityPane(async ({ win }) => {
    let group = win.document.querySelector(
      'setting-group[groupid="windowDensity"]'
    );
    ok(group, "windowDensity setting-group exists");
    is_element_visible(group, "windowDensity setting-group is visible");

    let control = getSettingControl("uiDensity", win);
    ok(control, "uiDensity setting-control exists");
    await control.updateComplete;
    is_element_visible(control, "uiDensity radio group is visible");
  });
});

add_task(async function test_window_density_radio_reflects_pref() {
  await withWindowDensityPane(async ({ win }) => {
    let control = getSettingControl("uiDensity", win);
    await control.updateComplete;

    const cases = [
      { pref: null, expected: "auto", desc: "no user value maps to automatic" },
      {
        pref: 0,
        expected: "standard",
        desc: "normal density maps to standard",
      },
      { pref: 1, expected: "compact", desc: "compact density maps to compact" },
      { pref: 2, expected: "touch", desc: "touch density maps to touch" },
    ];

    // Assert against the setting model rather than the rendered radio group:
    // the auto/standard boundary doesn't change the underlying int (both 0),
    // so the pref observer won't re-render the DOM, but get() still maps it.
    for (let { pref, expected, desc } of cases) {
      if (pref === null) {
        Services.prefs.clearUserPref("browser.uidensity");
      } else {
        Services.prefs.setIntPref("browser.uidensity", pref);
      }
      is(control.setting.value, expected, desc);
    }
  });
});

add_task(async function test_window_density_radio_updates_pref() {
  await withWindowDensityPane(async ({ win }) => {
    let control = getSettingControl("uiDensity", win);
    await control.updateComplete;

    // The setting writes the pref synchronously when the radio group changes,
    // so we assert on the pref directly rather than waiting for a "change"
    // event (which doesn't fire for the auto<->standard case, where the
    // underlying int stays 0).
    async function selectOption(value) {
      await control.updateComplete;
      let radioGroup = control.controlEl;
      let radio = [...radioGroup.querySelectorAll("moz-radio")].find(
        r => r.value == value
      );
      ok(radio, `moz-radio option for "${value}" exists`);
      radioGroup.value = value;
      radioGroup.dispatchEvent(new Event("change", { bubbles: true }));
    }

    await selectOption("compact");
    is(
      Services.prefs.getIntPref("browser.uidensity"),
      1,
      "Selecting compact sets browser.uidensity to 1"
    );

    await selectOption("touch");
    is(
      Services.prefs.getIntPref("browser.uidensity"),
      2,
      "Selecting touch sets browser.uidensity to 2"
    );

    await selectOption("standard");
    ok(
      Services.prefs.prefHasUserValue("browser.uidensity"),
      "Selecting standard records an explicit user value"
    );
    is(
      Services.prefs.getIntPref("browser.uidensity"),
      0,
      "Selecting standard sets browser.uidensity to 0"
    );

    await selectOption("auto");
    ok(
      !Services.prefs.prefHasUserValue("browser.uidensity"),
      "Selecting automatic clears the browser.uidensity user value"
    );
  });
});

add_task(async function test_browser_layout_group_in_tabs_browsing_pane() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.settings-redesign.enabled", true]],
  });
  await openPreferencesViaOpenPreferencesAPI("tabsBrowsing", {
    leaveOpen: true,
  });
  let doc = gBrowser.selectedBrowser.contentDocument;

  await BrowserTestUtils.waitForMutationCondition(
    doc.getElementById("mainPrefPane"),
    { childList: true, subtree: true },
    () => doc.querySelector('setting-group[groupid="browserLayout"]')
  );

  let group = doc.querySelector('setting-group[groupid="browserLayout"]');
  ok(group, "browserLayout setting-group exists in tabs-browsing pane");
  is_element_visible(group, "browserLayout setting-group is visible");

  await BrowserTestUtils.removeTab(gBrowser.selectedTab);
});
