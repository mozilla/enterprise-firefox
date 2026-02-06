/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Test the AI Window ask button exists, is visible and works for any AI Window.
 */
add_task(async function test_ask_button() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.firstrun.hasCompleted", true]],
  });

  const win = await openAIWindow();
  const exampleUrl = "https://example.com/";

  await BrowserTestUtils.loadURIString({
    browser: win.gBrowser.selectedTab.linkedBrowser,
    uriString: exampleUrl,
  });

  Assert.equal(
    win.gBrowser.selectedTab.linkedBrowser.currentURI.spec,
    exampleUrl,
    "Example url tab should be open"
  );

  const askButton = win.document.getElementById("smartwindow-ask-button");
  Assert.ok(askButton, "Ask button exists in the toolbar");
  Assert.ok(!askButton.hidden, "Ask button is initially visible for AI Window");

  /* the window switcher feature callout gets in front of the ask button
  if it exists, we must close before clicking on the ask button */
  const switcherFeatureCallout = win.document.querySelector(
    "#feature-callout .SMARTWINDOW_SWITCHER_BUTTON_CALLOUT"
  );

  if (switcherFeatureCallout) {
    const closeBtn = switcherFeatureCallout.querySelector(".dismiss-button");
    EventUtils.synthesizeMouseAtCenter(closeBtn, {}, win);
  }

  EventUtils.synthesizeMouseAtCenter(askButton, {}, win);

  await BrowserTestUtils.waitForMutationCondition(
    askButton,
    { attributes: true, attributeFilter: ["class"] },
    () => askButton.classList.contains("sidebar-is-open")
  );
  Assert.ok(
    askButton.classList.contains("sidebar-is-open"),
    "Ask button has the class sidebar-is-open after click"
  );

  const sidebar = win.document.getElementById("ai-window-box");
  if (sidebar) {
    Assert.ok(!sidebar.hidden, "AI Sidebar exists and is not hidden");
  }
  EventUtils.synthesizeMouseAtCenter(askButton, {}, win);
  Assert.ok(
    !askButton.classList.contains("sidebar-is-open"),
    "Ask button removed the sidebar-is-open class after second click"
  );
  Assert.ok(sidebar.hidden, "AI Sidebar is hidden after second click");

  askButton.setAttribute("tabindex", "-1");
  askButton.focus();
  Services.focus.setFocus(askButton, Services.focus.FLAG_BYKEY);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);

  await BrowserTestUtils.waitForMutationCondition(
    askButton,
    { attributes: true, attributeFilter: ["class"] },
    () => askButton.classList.contains("sidebar-is-open")
  );
  Assert.ok(
    askButton.classList.contains("sidebar-is-open"),
    "Ask button has the class sidebar-is-open after tab enter"
  );
  Assert.ok(!sidebar.hidden, "AI Sidebar is not hidden after tab enter");

  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  Assert.ok(
    !askButton.classList.contains("sidebar-is-open"),
    "Ask button removed the sidebar-is-open class after second tab enter"
  );
  Assert.ok(sidebar.hidden, "AI Sidebar is hidden after second tab enter");
  askButton.removeAttribute("tabindex");

  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});

/**
 * Test the AI Window ask button is not visible in Classic Window.
 */
add_task(async function test_classic_window() {
  let win;
  try {
    win = await BrowserTestUtils.openNewBrowserWindow({
      openerWindow: null,
    });
  } catch (e) {
    win = await BrowserTestUtils.openNewBrowserWindow();
    win.document.documentElement.setAttribute(
      "windowtype",
      "classicwindow-test"
    );
  }

  try {
    const askButton = win.document.getElementById("smartwindow-ask-button");
    Assert.ok(
      askButton.hidden,
      "Ask button is not visible in the toolbar for classic window"
    );
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});
