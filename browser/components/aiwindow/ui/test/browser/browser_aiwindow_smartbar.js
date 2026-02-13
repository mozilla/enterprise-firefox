/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests for the Smartbar integration in the Smart Window.
 *
 * These tests focus on the Smartbar integration with the Smart Window rather
 * than covering Smartbar functionality itself in depth.
 */

"use strict";

/**
 * Dispatch a `smartbar-commit` event.
 *
 * @param {MozBrowser} browser - The browser element
 * @param {string} value - The value to submit
 * @param {string} action - The action type
 */
async function dispatchSmartbarCommit(browser, value, action) {
  await SpecialPowers.spawn(browser, [value, action], async (val, act) => {
    const aiWindowElement = content.document.querySelector("ai-window");

    const smartbar = await ContentTaskUtils.waitForCondition(
      () => aiWindowElement.shadowRoot.querySelector("#ai-window-smartbar"),
      "Wait for Smartbar to be rendered"
    );

    const commitEvent = new content.CustomEvent("smartbar-commit", {
      detail: {
        value: val,
        action: act,
      },
      bubbles: true,
      composed: true,
    });

    smartbar.ownerDocument.dispatchEvent(commitEvent);
  });
}

add_task(async function test_smartbar_submit_chat() {
  const sb = this.sinon.createSandbox();

  try {
    const fetchWithHistoryStub = sb.stub(this.Chat, "fetchWithHistory");
    // prevent title generation network requests
    sb.stub(this.openAIEngine, "build");
    const win = await openAIWindow();
    const browser = win.gBrowser.selectedBrowser;

    await BrowserTestUtils.browserLoaded(browser, false, AIWINDOW_URL);
    await dispatchSmartbarCommit(browser, "Test prompt", "chat");
    await TestUtils.waitForTick();

    Assert.ok(
      fetchWithHistoryStub.calledOnce,
      "Should call fetchWithHistory once"
    );

    const conversation = fetchWithHistoryStub.firstCall.args[0];
    const messages = conversation.getMessagesInOpenAiFormat();
    const userMessage = messages.find(message => message.role === "user");

    Assert.equal(
      userMessage.content,
      "Test prompt",
      "Should submit correct value"
    );

    await BrowserTestUtils.closeWindow(win);
  } finally {
    sb.restore();
  }
});

add_task(async function test_smartbar_action_navigate() {
  const sb = this.sinon.createSandbox();

  try {
    const fetchWithHistoryStub = sb.stub(this.Chat, "fetchWithHistory");
    const win = await openAIWindow();
    const browser = win.gBrowser.selectedBrowser;

    await BrowserTestUtils.browserLoaded(browser, false, AIWINDOW_URL);

    const loaded = BrowserTestUtils.browserLoaded(
      browser,
      false,
      "https://example.com/"
    );

    await SpecialPowers.spawn(browser, [], async () => {
      const aiWindowElement = content.document.querySelector("ai-window");
      const smartbar = await ContentTaskUtils.waitForCondition(
        () => aiWindowElement.shadowRoot.querySelector("#ai-window-smartbar"),
        "Wait for Smartbar to be rendered"
      );

      smartbar.value = "https://example.com/";
      smartbar.smartbarAction = "navigate";
      smartbar.handleNavigation({});
    });

    await loaded;

    Assert.ok(
      !fetchWithHistoryStub.called,
      "fetchWithHistory should not be called for navigate action"
    );

    Assert.equal(
      browser.currentURI.spec,
      "https://example.com/",
      "Browser should navigate to the correct URL"
    );

    await BrowserTestUtils.closeWindow(win);
  } finally {
    sb.restore();
  }
});

add_task(async function test_smartbar_empty_submit() {
  const sb = this.sinon.createSandbox();

  try {
    const fetchWithHistoryStub = sb.stub(this.Chat, "fetchWithHistory");
    const win = await openAIWindow();
    const browser = win.gBrowser.selectedBrowser;

    await BrowserTestUtils.browserLoaded(browser, false, AIWINDOW_URL);
    await dispatchSmartbarCommit(browser, "", "chat");

    Assert.ok(
      !fetchWithHistoryStub.called,
      "fetchWithHistoryStub should not be called for empty prompts"
    );

    await BrowserTestUtils.closeWindow(win);
  } finally {
    sb.restore();
  }
});

add_task(async function test_smartbar_cta_default_search_engine_label() {
  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  await BrowserTestUtils.browserLoaded(browser, false, AIWINDOW_URL);

  const defaultSearchEngineInfo = await SpecialPowers.spawn(
    browser,
    [],
    async () => {
      const aiWindowElement = content.document.querySelector("ai-window");
      const smartbar = aiWindowElement.shadowRoot.querySelector(
        "#ai-window-smartbar"
      );
      const inputCta = smartbar.querySelector("input-cta");
      await ContentTaskUtils.waitForMutationCondition(
        inputCta,
        { attributes: true, subtree: true },
        () => inputCta.searchEngineInfo.name
      );
      const searchEngineName = inputCta.searchEngineInfo.name;
      inputCta.action = "search";
      await inputCta.updateComplete;
      const searchLabel = await content.document.l10n.formatValue(
        "aiwindow-input-cta-menu-label-search",
        { searchEngineName }
      );

      return {
        name: searchEngineName,
        hasIcon: !!inputCta.searchEngineInfo.icon,
        searchLabel,
      };
    }
  );

  Assert.ok(defaultSearchEngineInfo.name, "Search engine name should be set");
  Assert.ok(
    defaultSearchEngineInfo.hasIcon,
    "Search engine icon should be set"
  );
  Assert.equal(
    defaultSearchEngineInfo.searchLabel,
    `Search with ${defaultSearchEngineInfo.name}`,
    `Search label should include engine name: [${defaultSearchEngineInfo.searchLabel}]`
  );

  await BrowserTestUtils.closeWindow(win);
});
