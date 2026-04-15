/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests for Smartbar telemetry in the Smart Window.
 *
 * These tests verify that urlbar engagement and abandonment telemetry
 * includes the correct extra keys when using the smartbar.
 */

"use strict";

/**
 * @import { SmartbarAction } from "chrome://browser/content/aiwindow/components/input-cta/input-cta.mjs"
 */

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.searchEngagementTelemetry.enabled", true]],
  });
});

async function resetTelemetry() {
  await Services.fog.testFlushAllChildren();
  Services.fog.testResetFOG();
}

/**
 * Submit the smartbar with a specific action type.
 *
 * @param {MozBrowser} browser - The browser element
 * @param {object} options - Options for submission
 * @param {SmartbarAction} options.action - The action type
 * @param {"enter" | "button"} options.submitType - How to submit
 */
async function submitSmartbar(browser, { action, submitType } = {}) {
  await SpecialPowers.spawn(
    browser,
    [action, submitType],
    async (actionType, submission) => {
      const aiWindow = content.document.querySelector("ai-window");
      const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");

      smartbar._loadURL = () => {};
      smartbar.smartbarAction = actionType;
      smartbar.smartbarActionIsUserInitiated = true;

      const event =
        submission === "button"
          ? new content.PointerEvent("click", { bubbles: true })
          : new content.KeyboardEvent("keydown", {
              key: "Enter",
              bubbles: true,
            });
      smartbar.handleCommand(event);
    }
  );
}

// TODO (bug 2025792): Add tests for `extra_key`s `bounce` and `disable`.

add_task(async function test_smartbar_telemetry_navigate_submit_enter() {
  await resetTelemetry();

  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await typeInSmartbar(browser, "example.com");
  await submitSmartbar(browser, {
    action: "navigate",
    submitType: "enter",
  });

  const events = Glean.smartWindow.navigateSubmit.testGetValue();
  Assert.equal(events.length, 1, "Should have one navigate_submit event");
  Assert.ok(events[0].extra.chat_id, "navigate_submit has chat_id");
  Assert.ok(
    "message_seq" in events[0].extra,
    "navigate_submit has message_seq"
  );
  Assert.equal(
    events[0].extra.location,
    "fullpage",
    "navigate_submit has correct location"
  );
  Assert.equal(
    events[0].extra.detected_intent,
    "navigate",
    "navigate_submit has correct detected_intent"
  );
  Assert.equal(
    events[0].extra.submit_type,
    "enter",
    "navigate_submit has correct submit_type"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_smartbar_telemetry_navigate_submit_button() {
  await resetTelemetry();

  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await typeInSmartbar(browser, "example.com");
  await submitSmartbar(browser, {
    action: "navigate",
    submitType: "button",
  });

  const events = Glean.smartWindow.navigateSubmit.testGetValue();
  Assert.equal(events.length, 1, "Should have one navigate_submit event");
  Assert.equal(
    events[0].extra.submit_type,
    "button",
    "navigate_submit has correct submit_type"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_smartbar_telemetry_search_submit() {
  await resetTelemetry();

  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await typeInSmartbar(browser, "test search query");
  await submitSmartbar(browser, {
    action: "search",
    submitType: "button",
  });

  const events = Glean.smartWindow.searchSubmit.testGetValue();
  Assert.equal(events.length, 1, "Should have one search_submit event");
  Assert.ok(events[0].extra.chat_id, "search_submit has chat_id");
  Assert.ok("message_seq" in events[0].extra, "search_submit has message_seq");
  Assert.equal(
    events[0].extra.location,
    "fullpage",
    "search_submit has correct location"
  );
  Assert.equal(
    events[0].extra.detected_intent,
    "search",
    "search_submit has correct detected_intent"
  );
  Assert.ok(events[0].extra.provider, "search_submit has provider");
  Assert.equal(
    events[0].extra.length,
    "17",
    "search_submit has correct length"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_smartbar_telemetry_engagement_extra_keys() {
  await resetTelemetry();
  const sb = this.sinon.createSandbox();

  try {
    sb.stub(this.Chat, "fetchWithHistory");
    sb.stub(this.openAIEngine, "build");

    const win = await openAIWindow();
    const browser = win.gBrowser.selectedBrowser;

    await typeInSmartbar(browser, "test");
    await submitSmartbar(browser);

    await TestUtils.waitForTick();
    await Services.fog.testFlushAllChildren();

    const events = Glean.urlbar.engagement.testGetValue() ?? [];
    Assert.greater(events.length, 0, "Should have engagement events");
    const smartbarEvent = events.find(e => e.extra.sap === "smartbar");
    Assert.ok(smartbarEvent, "Should have a smartbar engagement event");
    Assert.equal(
      smartbarEvent.extra.location,
      "fullpage",
      "Engagement event includes the correct location extra key"
    );
    Assert.ok(
      smartbarEvent.extra.chat_id,
      "Engagement event includes chat_id extra key"
    );
    Assert.ok(
      "intent" in smartbarEvent.extra,
      "Engagement event includes intent extra key"
    );
    Assert.ok(
      "model" in smartbarEvent.extra,
      "Engagement event includes model extra key"
    );

    await BrowserTestUtils.closeWindow(win);
  } finally {
    sb.restore();
  }
});

add_task(async function test_smartbar_telemetry_abandonment_extra_keys() {
  await resetTelemetry();

  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  await typeInSmartbar(sidebarBrowser, "test");
  await SpecialPowers.spawn(sidebarBrowser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    smartbar.blur();
  });

  await TestUtils.waitForTick();
  await Services.fog.testFlushAllChildren();

  const events = Glean.urlbar.abandonment.testGetValue() ?? [];
  Assert.greater(events.length, 0, "Should have abandonment events");
  const smartbarEvent = events.find(e => e.extra.sap === "smartbar");
  Assert.ok(smartbarEvent, "Should have a smartbar abandonment event");
  Assert.equal(
    smartbarEvent.extra.location,
    "sidebar",
    "Abandonment event includes the correct location extra key"
  );
  Assert.ok(
    smartbarEvent.extra.chat_id,
    "Abandonment event includes chat_id extra key"
  );
  Assert.ok(
    "intent" in smartbarEvent.extra,
    "Abandonment event includes intent extra key"
  );
  Assert.ok(
    "model" in smartbarEvent.extra,
    "Abandonment event includes model extra key"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_smartbar_telemetry_intent_change_preview() {
  await resetTelemetry();

  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await typeInSmartbar(browser, "test query");

  await SpecialPowers.spawn(browser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    const inputCta = smartbar.querySelector("input-cta");
    const mozButton = inputCta.shadowRoot.querySelector("moz-button");
    const chevronButton = await ContentTaskUtils.waitForCondition(
      () => mozButton.shadowRoot.querySelector("#chevron-button"),
      "Wait for chevron button to be rendered"
    );

    const panelList = inputCta.shadowRoot.querySelector("panel-list");
    chevronButton.click();
    await ContentTaskUtils.waitForEvent(panelList, "shown");
  });

  const events = Glean.smartWindow.intentChangePreview.testGetValue();
  Assert.equal(events.length, 1, "intent_change_preview event recorded");
  Assert.ok(
    events[0].extra.current_intent,
    "intent_change_preview has intent_change_preview"
  );
  Assert.ok(events[0].extra.chat_id, "intent_change_preview has chat_id");
  Assert.ok(
    "message_seq" in events[0].extra,
    "intent_change_preview has message_seq"
  );
  Assert.equal(
    events[0].extra.location,
    "fullpage",
    "intent_change_preview has correct location"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_smartbar_telemetry_mention_start_inline() {
  await resetTelemetry();

  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await typeInSmartbar(browser, "@");
  await waitForMentionsOpen(browser);

  const events = Glean.smartWindow.mentionStart.testGetValue();
  Assert.equal(events.length, 1, "Should have mention_start events");
  Assert.ok(events[0].extra.chat_id, "mention_start has chat_id");
  Assert.ok(
    "mentions_available" in events[0].extra,
    "mention_start has mentions_available"
  );
  Assert.ok("message_seq" in events[0].extra, "mention_start has message_seq");
  Assert.equal(
    events[0].extra.location,
    "fullpage",
    "mention_start has correct location"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_smartbar_telemetry_add_tabs_click() {
  await resetTelemetry();

  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await SpecialPowers.spawn(browser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    const contextButton = smartbar.querySelector("context-icon-button");
    const button = contextButton.shadowRoot.querySelector("moz-button");
    button.click();
  });

  const events = Glean.smartWindow.addTabsClick.testGetValue();
  Assert.equal(events.length, 1, "Should have add_tabs_click events");
  Assert.ok(events[0].extra.chat_id, "add_tabs_click has chat_id");
  Assert.ok("message_seq" in events[0].extra, "add_tabs_click has message_seq");
  Assert.equal(
    events[0].extra.location,
    "fullpage",
    "add_tabs_click has correct location"
  );
  Assert.equal(
    events[0].extra.tabs_available,
    "1",
    "add_tabs_click has correct number of tabs_available"
  );
  Assert.equal(
    events[0].extra.tabs_preselected,
    "0",
    "add_tabs_click has correct number of tabs_preselected"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_smartbar_telemetry_mention_select_inline() {
  await resetTelemetry();

  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await typeInSmartbar(browser, "@");
  await waitForMentionsOpen(browser);

  await SpecialPowers.spawn(browser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    const panelList = smartbar.querySelector("smartwindow-panel-list");
    const panel = panelList.shadowRoot.querySelector("panel-list");
    await ContentTaskUtils.waitForMutationCondition(
      panel,
      { childList: true, subtree: true },
      () => panel.querySelector("panel-item:not(.panel-section-header)")
    );
    const firstItem = panel.querySelector(
      "panel-item:not(.panel-section-header)"
    );
    firstItem.click();
  });

  const events = Glean.smartWindow.mentionSelect.testGetValue();
  Assert.equal(events.length, 1, "Should have mention_select events");
  Assert.ok(events[0].extra.chat_id, "mention_select has chat_id");
  Assert.ok(
    "mentions_available" in events[0].extra,
    "mention_select has mentions_available"
  );
  Assert.ok("message_seq" in events[0].extra, "mention_select has message_seq");
  Assert.equal(
    events[0].extra.location,
    "fullpage",
    "mention_select has correct location"
  );
  Assert.greater(
    Number(events[0].extra.length),
    0,
    "mention_select event reports the length of the mention"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_smartbar_telemetry_add_tabs_selection() {
  await resetTelemetry();

  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await SpecialPowers.spawn(browser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    const contextButton = smartbar.querySelector("context-icon-button");
    const button = contextButton.shadowRoot.querySelector("moz-button");
    button.click();

    const panelList = smartbar.querySelector("smartwindow-panel-list");
    const panel = panelList.shadowRoot.querySelector("panel-list");
    await ContentTaskUtils.waitForMutationCondition(
      panel,
      { childList: true, subtree: true },
      () => panel.querySelector("panel-item:not(.panel-section-header)")
    );
    const firstItem = panel.querySelector(
      "panel-item:not(.panel-section-header)"
    );
    firstItem.click();
  });

  const events = Glean.smartWindow.addTabsSelection.testGetValue();
  Assert.equal(events.length, 1, "Should have add_tabs_selection events");
  Assert.ok(events[0].extra.chat_id, "add_tabs_selection has chat_id");
  Assert.ok(
    "message_seq" in events[0].extra,
    "add_tabs_selection has message_seq"
  );
  Assert.equal(
    events[0].extra.location,
    "fullpage",
    "add_tabs_selection has correct location"
  );
  Assert.equal(
    events[0].extra.tabs_available,
    "1",
    "add_tabs_selection has correct number of tabs_available"
  );
  Assert.equal(
    events[0].extra.tabs_preselected,
    "0",
    "add_tabs_selection has correct number of tabs_preselected"
  );
  Assert.equal(
    events[0].extra.tabs_selected,
    "1",
    "add_tabs_selection has correct number of tabs_selected"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_smartbar_telemetry_mention_remove_inline() {
  await resetTelemetry();

  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await typeInSmartbar(browser, "@");
  await waitForMentionsOpen(browser);

  await SpecialPowers.spawn(browser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    const panelList = smartbar.querySelector("smartwindow-panel-list");
    const panel = panelList.shadowRoot.querySelector("panel-list");
    await ContentTaskUtils.waitForMutationCondition(
      panel,
      { childList: true, subtree: true },
      () => panel.querySelector("panel-item:not(.panel-section-header)")
    );
    const firstItem = panel.querySelector(
      "panel-item:not(.panel-section-header)"
    );
    firstItem.click();
  });

  await waitForMentionInserted(browser);
  await resetTelemetry();

  await BrowserTestUtils.synthesizeKey("KEY_Backspace", {}, browser);
  await BrowserTestUtils.synthesizeKey("KEY_Backspace", {}, browser);

  const events = Glean.smartWindow.mentionRemove.testGetValue();
  Assert.equal(events.length, 1, "Should have mention_remove events");
  Assert.ok(events[0].extra.chat_id, "mention_remove has chat_id");
  Assert.ok("message_seq" in events[0].extra, "mention_remove has message_seq");
  Assert.equal(
    events[0].extra.location,
    "fullpage",
    "mention_remove has correct location"
  );
  Assert.equal(
    events[0].extra.mentions,
    "0",
    "mention_remove reports the remaining mentions count"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_smartbar_telemetry_remove_tab() {
  await resetTelemetry();

  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await SpecialPowers.spawn(browser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    const contextButton = smartbar.querySelector("context-icon-button");
    const button = contextButton.shadowRoot.querySelector("moz-button");
    button.click();

    const panelList = smartbar.querySelector("smartwindow-panel-list");
    const panel = panelList.shadowRoot.querySelector("panel-list");
    await ContentTaskUtils.waitForMutationCondition(
      panel,
      { childList: true, subtree: true },
      () => panel.querySelector("panel-item:not(.panel-section-header)")
    );
    const firstItem = panel.querySelector(
      "panel-item:not(.panel-section-header)"
    );
    firstItem.click();
  });

  await resetTelemetry();

  await SpecialPowers.spawn(browser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    const chipContainer = smartbar.querySelector("website-chip-container");
    const chip = chipContainer.shadowRoot.querySelector("ai-website-chip");
    const removeButton = chip.shadowRoot.querySelector(".chip-remove");
    removeButton.click();
  });

  const events = Glean.smartWindow.removeTab.testGetValue();
  Assert.equal(events.length, 1, "Should have remove_tab events");
  Assert.ok(events[0].extra.chat_id, "remove_tab has chat_id");
  Assert.ok("message_seq" in events[0].extra, "remove_tab has message_seq");
  Assert.equal(
    events[0].extra.location,
    "fullpage",
    "remove_tab has correct location"
  );
  Assert.equal(
    events[0].extra.tabs_selected,
    "0",
    "remove_tab reports the remaining tabs count"
  );

  await BrowserTestUtils.closeWindow(win);
});

add_task(
  async function test_smartbar_telemetry_mention_remove_with_multiple_mentions() {
    await resetTelemetry();

    const win = await openAIWindow();
    const browser = win.gBrowser.selectedBrowser;

    await typeInSmartbar(browser, "@");
    await waitForMentionsOpen(browser);

    await SpecialPowers.spawn(browser, [], async () => {
      const aiWindow = content.document.querySelector("ai-window");
      const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
      const panelList = smartbar.querySelector("smartwindow-panel-list");
      const panel = panelList.shadowRoot.querySelector("panel-list");
      await ContentTaskUtils.waitForMutationCondition(
        panel,
        { childList: true, subtree: true },
        () => panel.querySelector("panel-item:not(.panel-section-header)")
      );
      const firstItem = panel.querySelector(
        "panel-item:not(.panel-section-header)"
      );
      firstItem.click();
    });

    await waitForMentionInserted(browser);

    await typeInSmartbar(browser, " @");
    await waitForMentionsOpen(browser);

    await SpecialPowers.spawn(browser, [], async () => {
      const aiWindow = content.document.querySelector("ai-window");
      const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
      const panelList = smartbar.querySelector("smartwindow-panel-list");
      const panel = panelList.shadowRoot.querySelector("panel-list");
      await ContentTaskUtils.waitForMutationCondition(
        panel,
        { childList: true, subtree: true },
        () => panel.querySelector("panel-item:not(.panel-section-header)")
      );
      const firstItem = panel.querySelector(
        "panel-item:not(.panel-section-header)"
      );
      firstItem.click();
    });

    await SpecialPowers.spawn(browser, [], async () => {
      const aiWindow = content.document.querySelector("ai-window");
      const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
      const editor = smartbar.querySelector("moz-multiline-editor");

      await ContentTaskUtils.waitForMutationCondition(
        editor.shadowRoot,
        { childList: true, subtree: true },
        () => editor.shadowRoot.querySelectorAll("ai-website-chip").length === 2
      );
    });

    await resetTelemetry();

    await BrowserTestUtils.synthesizeKey("KEY_Backspace", {}, browser);
    await BrowserTestUtils.synthesizeKey("KEY_Backspace", {}, browser);

    const events = Glean.smartWindow.mentionRemove.testGetValue();
    Assert.equal(events.length, 1, "Should have one mention_remove event");
    Assert.equal(
      events[0].extra.mentions,
      "1",
      "mention_remove reports 1 remaining mention after removing one of two"
    );

    await BrowserTestUtils.closeWindow(win);
  }
);

add_task(async function test_smartbar_telemetry_mention_start_sidebar() {
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();
  await resetTelemetry();

  await typeInSmartbar(sidebarBrowser, "@");
  await waitForMentionsOpen(sidebarBrowser);

  const events = Glean.smartWindow.mentionStart.testGetValue();
  Assert.equal(events.length, 1, "Should have mention_start events");
  Assert.ok(events[0].extra.chat_id, "mention_start has chat_id");
  Assert.ok(
    "mentions_available" in events[0].extra,
    "mention_start has mentions_available"
  );
  Assert.ok("message_seq" in events[0].extra, "mention_start has message_seq");
  Assert.equal(
    events[0].extra.location,
    "sidebar",
    "mention_start has correct location for sidebar"
  );

  await BrowserTestUtils.closeWindow(win);
});
