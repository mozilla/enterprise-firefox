/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests for Smartbar mentions functionality.
 *
 * These tests verify that users can trigger and insert mention suggestions into
 * the Smartbar editor.
 */

"use strict";

const { SmartbarMentionsPanelSearch, MENTION_TYPE } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/urlbar/SmartbarMentionsPanelSearch.sys.mjs"
  );

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.search.suggest.enabled", false],
      ["browser.urlbar.suggest.searches", false],
    ],
  });

  const providerStub = sinon.stub(
    SmartbarMentionsPanelSearch.prototype,
    "startQuery"
  );
  providerStub.returns([
    {
      url: "https://example.com/1",
      title: "Page 1",
      icon: "",
      type: MENTION_TYPE.TAB_OPEN,
      timestamp: Date.now(),
    },
    {
      url: "https://example.com/2",
      title: "Page 2",
      icon: "",
      type: MENTION_TYPE.TAB_RECENTLY_CLOSED,
      timestamp: Date.now(),
    },
  ]);
  registerCleanupFunction(() => {
    providerStub.restore();
  });
});

/**
 * Wait for mentions to be open.
 *
 * @param {MozBrowser} browser - The browser element
 * @returns {Promise<boolean>} True if mentions are open
 */
async function waitForMentionsOpen(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const aiWindowElement = content.document.querySelector("ai-window");
    const smartbar = aiWindowElement.shadowRoot.querySelector(
      "#ai-window-smartbar"
    );
    const editor = smartbar.querySelector("moz-multiline-editor");

    await ContentTaskUtils.waitForCondition(
      () => editor.isHandlingMentions,
      "Wait for mentions to open"
    );

    return editor.isHandlingMentions;
  });
}

/**
 * Wait for panel list to be visible.
 *
 * @param {MozBrowser} browser - The browser element
 * @returns {Promise<boolean>} True if panel is visible
 */
async function waitForPanelOpen(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const aiWindowElement = content.document.querySelector("ai-window");
    const smartbar = aiWindowElement.shadowRoot.querySelector(
      "#ai-window-smartbar"
    );
    const panelList = smartbar.querySelector("suggestions-panel-list");
    const panel = panelList.shadowRoot.querySelector("panel-list");

    await ContentTaskUtils.waitForMutationCondition(
      panel,
      { attributes: true, attributeFilter: ["open"] },
      () => panel.hasAttribute("open")
    );

    return panel.hasAttribute("open");
  });
}

/**
 * Wait for a mention to be inserted.
 *
 * @param {MozBrowser} browser - The browser element
 * @returns {Promise<boolean>} True if the mention exists
 */
async function waitForMentionInserted(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const aiWindowElement = content.document.querySelector("ai-window");
    const smartbar = aiWindowElement.shadowRoot.querySelector(
      "#ai-window-smartbar"
    );
    const editor = smartbar.querySelector("moz-multiline-editor");

    await ContentTaskUtils.waitForMutationCondition(
      editor.shadowRoot,
      { childList: true, subtree: true },
      () => editor.shadowRoot.querySelector("ai-website-chip") !== null
    );

    return !!editor.shadowRoot.querySelector("ai-website-chip");
  });
}

/**
 * Type text into the editor using BrowserTestUtils.synthesizeKey.
 *
 * @param {MozBrowser} browser - The browser element
 * @param {string} text - Text to type
 */
async function typeInEditor(browser, text) {
  await SpecialPowers.spawn(browser, [], async () => {
    const aiWindowElement = content.document.querySelector("ai-window");
    const smartbar = aiWindowElement.shadowRoot.querySelector(
      "#ai-window-smartbar"
    );
    const editor = smartbar.querySelector("moz-multiline-editor");
    editor.focus();
  });
  for (const char of text) {
    await BrowserTestUtils.synthesizeKey(char, {}, browser);
  }
}

add_task(async function test_mentions_trigger_zero_prefix() {
  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await BrowserTestUtils.browserLoaded(browser, false, AIWINDOW_URL);
  await typeInEditor(browser, "@");
  const mentionsOpen = await waitForMentionsOpen(browser);

  Assert.ok(
    mentionsOpen,
    "Mentions should open after typing @ without leading text"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_mentions_trigger_after_text() {
  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await BrowserTestUtils.browserLoaded(browser, false, AIWINDOW_URL);
  await typeInEditor(browser, "test @");
  const mentionsOpen = await waitForMentionsOpen(browser);

  Assert.ok(
    mentionsOpen,
    "Mentions should open after typing @ with leading text"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_mentions_suggestions_panel_shows() {
  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await BrowserTestUtils.browserLoaded(browser, false, AIWINDOW_URL);
  await typeInEditor(browser, "@");
  const panelVisible = await waitForPanelOpen(browser);

  Assert.ok(
    panelVisible,
    "Panel list should show mention suggestions after typing @"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_mentions_insert_on_click() {
  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await BrowserTestUtils.browserLoaded(browser, false, AIWINDOW_URL);
  await typeInEditor(browser, "@");
  await SpecialPowers.spawn(browser, [], async () => {
    const aiWindowElement = content.document.querySelector("ai-window");
    const smartbar = aiWindowElement.shadowRoot.querySelector(
      "#ai-window-smartbar"
    );
    const panelList = smartbar.querySelector("suggestions-panel-list");
    const panel = panelList.shadowRoot.querySelector("panel-list");

    const firstItem = panel.querySelector(
      "panel-item:not(.panel-section-header)"
    );
    firstItem.click();
  });

  const hasMention = await waitForMentionInserted(browser);
  Assert.ok(
    hasMention,
    "Editor should contain a mention after clicking on a suggestion"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_mentions_insert_on_enter() {
  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await BrowserTestUtils.browserLoaded(browser, false, AIWINDOW_URL);
  await typeInEditor(browser, "@");
  await SpecialPowers.spawn(browser, [], async () => {
    const aiWindowElement = content.document.querySelector("ai-window");
    const smartbar = aiWindowElement.shadowRoot.querySelector(
      "#ai-window-smartbar"
    );
    const panelList = smartbar.querySelector("suggestions-panel-list");
    const panel = panelList.shadowRoot.querySelector("panel-list");

    await ContentTaskUtils.waitForCondition(
      () => panel.querySelector("panel-item:not(.panel-section-header)"),
      "Wait for panel items to be available"
    );
  });
  await BrowserTestUtils.synthesizeKey("KEY_ArrowDown", {}, browser);
  await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
  const hasMention = await waitForMentionInserted(browser);
  Assert.ok(hasMention, "Editor should contain a mention after pressing Enter");

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_mentions_insert_from_context_button() {
  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await BrowserTestUtils.browserLoaded(browser, false, AIWINDOW_URL);
  await SpecialPowers.spawn(browser, [], async () => {
    const aiWindowElement = content.document.querySelector("ai-window");
    const smartbar = aiWindowElement.shadowRoot.querySelector(
      "#ai-window-smartbar"
    );
    const contextButton = smartbar.querySelector("context-icon-button");
    const button = contextButton.shadowRoot.querySelector("moz-button");
    button.click();

    const panelList = smartbar.querySelector("suggestions-panel-list");
    const panel = panelList.shadowRoot.querySelector("panel-list");
    await ContentTaskUtils.waitForCondition(
      () => panel.querySelector("panel-item:not(.panel-section-header)"),
      "Wait for panel items to be available"
    );
    const firstItem = panel.querySelector(
      "panel-item:not(.panel-section-header)"
    );
    firstItem.click();
  });

  const hasMention = await waitForMentionInserted(browser);
  Assert.ok(
    hasMention,
    "Editor should contain a mention after selecting from context button menu"
  );

  await BrowserTestUtils.closeWindow(win);
});
