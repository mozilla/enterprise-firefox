/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Test the AI Window ask button exists, is visible and works for any AI Window.
 */
add_task(async function test_ask_button() {
  let win;
  try {
    win = await BrowserTestUtils.openNewBrowserWindow({
      openerWindow: null,
      aiWindow: true,
    });
  } catch (e) {
    win = await BrowserTestUtils.openNewBrowserWindow();
    win.document.documentElement.setAttribute("windowtype", "aiwindow-test");
  }

  try {
    const askButton = win.document.getElementById("aiwindow-ask-button");
    Assert.ok(askButton, "Ask button exists in the toolbar");
    Assert.ok(
      !askButton.hidden,
      "Ask button is initially visible for AI Window"
    );

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
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
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
    const askButton = win.document.getElementById("aiwindow-ask-button");
    Assert.ok(
      askButton.hidden,
      "Ask button is not visible in the toolbar for classic window"
    );
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});
