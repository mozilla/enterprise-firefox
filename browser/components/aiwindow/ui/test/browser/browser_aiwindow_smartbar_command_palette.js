/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { Region } = ChromeUtils.importESModule(
  "resource://gre/modules/Region.sys.mjs"
);

add_setup(async function () {
  const originalRegion = Region.home;
  Region._setHomeRegion("US", false);
  registerCleanupFunction(() => {
    Region._setHomeRegion(originalRegion, false);
  });

  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.search.suggest.enabled", false],
      ["browser.smartwindow.endpoint", "http://localhost:0/v1"],
      ["browser.smartwindow.agent.enabled", true],
      ["browser.smartwindow.agent.supportedRegions", "US"],
    ],
  });
});

/**
 * Reads the command panel's groups
 *
 * @param {MozBrowser} browser
 * @returns {Promise<Array>} panel groups
 */
async function getCommandGroups(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    const panelList = smartbar.querySelector("smartwindow-panel-list");
    return panelList.groups;
  });
}

// TODO: Bug 2060620 - Add command palette navigation test

add_task(async function test_slash_opens_command_palette() {
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  await typeInSmartbar(sidebarBrowser, "/");
  await waitForPanelOpen(sidebarBrowser);

  const groups = await getCommandGroups(sidebarBrowser);
  Assert.equal(groups.length, 1, "One command group is shown");
  Assert.equal(groups[0].header, "TASKS", "Group has the 'TASKS' header");
  Assert.ok(
    groups[0].items.some(item => item.id === "watch"),
    "The watch command is listed"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_command_palette_filters_by_query() {
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  await typeInSmartbar(sidebarBrowser, "/wat");
  await waitForPanelOpen(sidebarBrowser);
  const groups = await getCommandGroups(sidebarBrowser);
  Assert.ok(
    groups[0]?.items.some(item => item.id === "watch"),
    "'/wat' matches the watch command"
  );

  // Extend the query so nothing matches
  await typeInSmartbar(sidebarBrowser, "xyz");
  await SpecialPowers.spawn(sidebarBrowser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    const panelList = smartbar.querySelector("smartwindow-panel-list");
    await ContentTaskUtils.waitForCondition(
      () => !panelList.groups.length,
      "Command panel empties when nothing matches"
    );
  });

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_command_selection_completes_input() {
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  await typeInSmartbar(sidebarBrowser, "/");
  await waitForPanelOpen(sidebarBrowser);

  await SpecialPowers.spawn(sidebarBrowser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    const panelList = smartbar.querySelector("smartwindow-panel-list");
    const panel = panelList.shadowRoot.querySelector("panel-list");
    const firstItem = panel.querySelector(
      "panel-item:not(.panel-section-header)"
    );
    firstItem.click();

    await ContentTaskUtils.waitForCondition(
      () => smartbar.value === "/watch ",
      "Selecting the command completes the input to '/watch '"
    );
  });

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_command_selection_is_undoable() {
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  await typeInSmartbar(sidebarBrowser, "/wat");
  await waitForPanelOpen(sidebarBrowser);

  await SpecialPowers.spawn(sidebarBrowser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    const panelList = smartbar.querySelector("smartwindow-panel-list");
    const panel = panelList.shadowRoot.querySelector("panel-list");

    panel.querySelector("panel-item:not(.panel-section-header)").click();
    await ContentTaskUtils.waitForCondition(
      () => smartbar.value === "/watch ",
      "Selecting the command completes the input to '/watch '"
    );

    smartbar.inputField.view.focus();
    EventUtils.synthesizeKey("z", { accelKey: true }, content);
    await ContentTaskUtils.waitForCondition(
      () => !smartbar.value.startsWith("/watch"),
      "Cmd+z undoes the command completion"
    );
  });

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_unknown_command_does_not_block_submit() {
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  await typeInSmartbar(sidebarBrowser, "/wats");

  await SpecialPowers.spawn(sidebarBrowser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    await ContentTaskUtils.waitForCondition(
      () => smartbar.inputField.isHandlingCommands === false,
      "Unknown '/wats' does not keep the command palette handling input"
    );
  });

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_slash_command_classified_as_chat() {
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  await typeInSmartbar(sidebarBrowser, "/watch watch the price");
  await waitForSmartbarAction(sidebarBrowser, "chat");

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_slash_command_submit_does_not_navigate() {
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  await stubLoadURL(sidebarBrowser, { captureURL: true });

  await typeInSmartbar(sidebarBrowser, "/watch watch the price");
  await submitSmartbar(sidebarBrowser);

  const { called } = await getStubLoadURLResult(sidebarBrowser);
  Assert.ok(!called, "Submitting a '/command' does not navigate Go");

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_palette_hidden_when_agent_disabled() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.agent.enabled", false]],
  });

  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  await typeInSmartbar(sidebarBrowser, "/");

  await SpecialPowers.spawn(sidebarBrowser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    const panelList = smartbar.querySelector("smartwindow-panel-list");

    await ContentTaskUtils.waitForCondition(
      () =>
        !panelList.groups.length &&
        smartbar.inputField.isHandlingCommands === false,
      "Command palette stays closed when the agent pref is disabled"
    );
  });

  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});
