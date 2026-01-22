/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Ensure Window Switcher button is visible when AI Window is enabled in prefs
add_task(async function test_window_switcher_button_visibility() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.aiwindow.enabled", false]],
  });

  let button = document.getElementById("ai-window-toggle");
  Assert.ok(
    button?.hidden,
    "Window switcher button should be hidden when AI Window is disabled"
  );

  await SpecialPowers.popPrefEnv();

  await SpecialPowers.pushPrefEnv({
    set: [["browser.aiwindow.enabled", true]],
  });

  button = document.getElementById("ai-window-toggle");
  Assert.ok(
    button && !button.hidden,
    "Window switcher button should be visible when AI Window is enabled"
  );

  await SpecialPowers.popPrefEnv();
});

// if (browser.aiwindow.enabled) Classic Window should switch to AI Window on click
add_task(async function test_switch_to_ai_window() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.aiwindow.enabled", true]],
  });

  if (document.documentElement.hasAttribute("ai-window")) {
    document.documentElement.removeAttribute("ai-window");
  }

  let button = document.getElementById("ai-window-toggle");
  let view = PanelMultiView.getViewNode(document, "ai-window-toggle-view");

  let viewShownPromise = BrowserTestUtils.waitForEvent(view, "ViewShown");
  button.click();
  await viewShownPromise;

  let aiButton = view.querySelector("#ai-window-switch-ai");
  aiButton.click();

  await TestUtils.waitForCondition(
    () => document.documentElement.hasAttribute("ai-window"),
    "Window should have ai-window attribute after switching"
  );

  Assert.ok(
    document.documentElement.hasAttribute("ai-window"),
    "Window should be in AI Window mode"
  );

  let iconListImage = window.getComputedStyle(button)["list-style-image"];
  Assert.ok(
    iconListImage.includes("ai-window.svg"),
    "Button icon should change to AI Window icon"
  );

  await TestUtils.waitForCondition(
    () => PanelUI.panel.state === "closed",
    "Panel should close after switching"
  );

  await SpecialPowers.popPrefEnv();
});

// if (browser.aiwindow.enabled) AI Window should switch to Classic Window on click
add_task(async function test_switch_to_classic_window() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.aiwindow.enabled", true]],
  });

  if (!document.documentElement.hasAttribute("ai-window")) {
    document.documentElement.setAttribute("ai-window", "");
  }

  let button = document.getElementById("ai-window-toggle");
  let view = PanelMultiView.getViewNode(document, "ai-window-toggle-view");

  let viewShownPromise = BrowserTestUtils.waitForEvent(view, "ViewShown");
  button.click();
  await viewShownPromise;

  let classicButton = view.querySelector("#ai-window-switch-classic");
  classicButton.click();

  await TestUtils.waitForCondition(
    () => !document.documentElement.hasAttribute("ai-window"),
    "Window should not have ai-window attribute after switching"
  );

  Assert.ok(
    !document.documentElement.hasAttribute("ai-window"),
    "Window should be in Classic Window mode"
  );

  let iconListImage = window.getComputedStyle(button)["list-style-image"];
  Assert.ok(
    iconListImage.includes("icon32.png"),
    "Button icon should change to Classic Window icon"
  );

  await TestUtils.waitForCondition(
    () => PanelUI.panel.state === "closed",
    "Panel should close after switching"
  );

  await SpecialPowers.popPrefEnv();
});

// Window switcher should be positioned in TabsToolbar when vertical tabs are disabled
add_task(async function test_switcher_position_horizontal_tabs() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.aiwindow.enabled", true],
      ["sidebar.verticalTabs", false],
    ],
  });

  let button = document.getElementById("ai-window-toggle");
  Assert.ok(button, "Window switcher button should exist");

  let tabsToolbar = document.getElementById("TabsToolbar");
  Assert.ok(tabsToolbar, "TabsToolbar should exist");

  Assert.equal(
    button.closest("#TabsToolbar"),
    tabsToolbar,
    "Window switcher should be in TabsToolbar when vertical tabs are disabled"
  );

  Assert.ok(
    !button.closest("#nav-bar"),
    "Window switcher should not be in nav-bar when vertical tabs are disabled"
  );

  await SpecialPowers.popPrefEnv();
});

// Window switcher should be positioned in nav-bar when vertical tabs are enabled
add_task(async function test_switcher_position_vertical_tabs() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.aiwindow.enabled", true],
      ["sidebar.verticalTabs", true],
    ],
  });

  let button = document.getElementById("ai-window-toggle");
  Assert.ok(button, "Window switcher button should exist");

  let navBar = document.getElementById("nav-bar");
  Assert.ok(navBar, "nav-bar should exist");

  Assert.equal(
    button.closest("#nav-bar"),
    navBar,
    "Window switcher should be in nav-bar when vertical tabs are enabled"
  );

  Assert.ok(
    !button.closest("#TabsToolbar"),
    "Window switcher should not be in TabsToolbar when vertical tabs are enabled"
  );

  let panelUIButton = document.getElementById("PanelUI-button");
  Assert.ok(panelUIButton, "PanelUI button should exist");

  await SpecialPowers.popPrefEnv();
});

// Window switcher should dynamically reposition when horizontal/vertical tabs preference changes
add_task(async function test_switcher_repositions_on_pref_change() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.aiwindow.enabled", true],
      ["sidebar.verticalTabs", false],
    ],
  });

  let button = document.getElementById("ai-window-toggle");
  let tabsToolbar = document.getElementById("TabsToolbar");
  let navBar = document.getElementById("nav-bar");

  Assert.equal(
    button.closest("#TabsToolbar"),
    tabsToolbar,
    "Window switcher should initially be in TabsToolbar"
  );

  await SpecialPowers.pushPrefEnv({
    set: [["sidebar.verticalTabs", true]],
  });

  await BrowserTestUtils.waitForMutationCondition(
    navBar,
    { childList: true, subtree: true },
    () => button.closest("#nav-bar") === navBar
  );

  Assert.equal(
    button.closest("#nav-bar"),
    navBar,
    "Window switcher should be in nav-bar after enabling vertical tabs"
  );

  await SpecialPowers.pushPrefEnv({
    set: [["sidebar.verticalTabs", false]],
  });

  await BrowserTestUtils.waitForMutationCondition(
    tabsToolbar,
    { childList: true, subtree: true },
    () => button.closest("#TabsToolbar") === tabsToolbar
  );

  Assert.equal(
    button.closest("#TabsToolbar"),
    tabsToolbar,
    "Window switcher should be back in TabsToolbar after disabling vertical tabs"
  );

  await SpecialPowers.flushPrefEnv();
});
