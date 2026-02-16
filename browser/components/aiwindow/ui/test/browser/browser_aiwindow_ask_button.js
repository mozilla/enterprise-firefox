/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromiseTestUtils.sys.mjs"
);
// AI chat content loads Fluent strings asynchronously, which may not complete
// before the test finishes. This is expected and doesn't affect test behavior.
PromiseTestUtils.allowMatchingRejectionsGlobally(
  /Missing message.*smartwindow-messages-document-title/
);

async function testImmersiveView(isVerticalTabs) {
  await SpecialPowers.pushPrefEnv({
    set: [["sidebar.verticalTabs", isVerticalTabs]],
  });
  const win = await openAIWindow();
  const chromeRoot = win.document.documentElement;

  Assert.ok(
    chromeRoot.hasAttribute("aiwindow-immersive-view"),
    "Chrome window has the aiwindow-immersive-view attribute"
  );

  const askButton = win.document.getElementById("smartwindow-ask-button");
  Assert.ok(askButton, "Ask button exists in the toolbar");
  Assert.ok(
    BrowserTestUtils.isHidden(askButton),
    "Ask button is not visible for a new tab (immersive view) in Smart Window"
  );
  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
}

/**
 * Test if the toolbar ask button exists and toggles the assistant sidebar
 */
add_task(async function test_ask_button() {
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
  Assert.ok(
    !BrowserTestUtils.isHidden(askButton),
    "Ask button is initially visible for Smart Window"
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

  await BrowserTestUtils.closeWindow(win);
});

/**
 * Test if the toolbar ask button is not visible in Classic Window.
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
      BrowserTestUtils.isHidden(askButton),
      "Ask button is not visible in the toolbar for classic window"
    );
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * Test if the toolbar ask button is not visible in immersive view (new tab)
 */
add_task(async function test_ask_button_immersive_view() {
  await testImmersiveView(false);
});

/**
 * Test if the toolbar ask button is not visible in immersive view on vertical tabs (new tab)
 */
add_task(async function test_ask_button_immersive_view_vertical_tabs() {
  await testImmersiveView(true);
});
