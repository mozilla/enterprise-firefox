/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromiseTestUtils.sys.mjs"
);

// AI chat content loads Fluent strings asynchronously, which may not complete
// before the test finishes. This is expected and doesn't affect test behavior.
PromiseTestUtils.allowMatchingRejectionsGlobally(
  /Missing message.*smartwindow-messages-document-title/
);

/**
 * Tests that context url for user messages and smartbar context chips, which
 * are retrieved from the same function, work in both places. Context urls
 * come from aiwindow/ui/modules/ChatUtils.sys.mjs::getCurrentTabUrl()
 */
describe("context url retrieval", () => {
  let gAiWindow;
  let gRestoreNetworkBoundaries;
  const TEST_PAGE_1 =
    "https://example.com/browser/browser/components/aiwindow/ui/test/browser/test_context_url_page.html";

  const TEST_PAGE_2 =
    "https://example.com/browser/browser/components/aiwindow/ui/test/browser/test_context_url_page2.html";

  beforeEach(async () => {
    ({ restore: gRestoreNetworkBoundaries } =
      await stubEngineNetworkBoundaries());
    gAiWindow = await openAIWindow();
  });

  afterEach(async () => {
    if (gAiWindow) {
      await BrowserTestUtils.closeWindow(gAiWindow);
      gAiWindow = null;
    }
    await gRestoreNetworkBoundaries();
  });

  describe("when the user navigates to a site", () => {
    beforeEach(async () => {
      await promiseNavigateAndLoad(
        gAiWindow.gBrowser.selectedBrowser,
        TEST_PAGE_1
      );
    });

    it("should make the context chip show the 'Example Domain' context label", async () => {
      Assert.ok(AIWindowUI.isSidebarOpen(gAiWindow), "Sidebar should be open");

      const sidebarBrowser =
        gAiWindow.document.getElementById("ai-window-browser");

      const labels = await getSmartbarContextChipLabels(
        sidebarBrowser,
        "example.com"
      );

      Assert.equal(labels.length, 1, "There should be one context chip");
      Assert.equal(
        labels[0],
        "Example Domain",
        `Expected a context chip labeled 'Example Domain', got: ${labels[0]}`
      );
    });

    it("should refresh the context chip to say 'Website Name'", async () => {
      Assert.ok(AIWindowUI.isSidebarOpen(gAiWindow), "Sidebar should be open");

      const sidebarBrowser =
        gAiWindow.document.getElementById("ai-window-browser");

      let labels = await getSmartbarContextChipLabels(
        sidebarBrowser,
        "test_context_url_page.html"
      );

      Assert.equal(
        labels[0],
        "Example Domain",
        `Expected a context chip labeled 'Example Domain', got: ${labels[0]}`
      );

      await promiseNavigateAndLoad(
        gAiWindow.gBrowser.selectedBrowser,
        TEST_PAGE_2
      );

      await BrowserTestUtils.waitForCondition(
        () => gAiWindow.gBrowser.selectedTab.label === "Website Title",
        "Wait for tab title to update to 'Website Title'"
      );

      labels = await getSmartbarContextChipLabels(
        sidebarBrowser,
        "test_context_url_page2.html"
      );

      Assert.equal(
        labels.length,
        1,
        "There should still be only one context chip"
      );
      info(`labels: ${labels}`);
      Assert.equal(
        labels[0],
        "Website Title",
        `Expected a context chip labeled 'Website Title', got: ${labels[0]}`
      );
    });
  });

  describe("when the user submits a message", () => {
    let gRestoreSignIn;

    beforeEach(async () => {
      await SpecialPowers.pushPrefEnv({
        set: [["browser.search.suggest.enabled", false]],
      });

      gRestoreSignIn = skipSignIn();

      await promiseNavigateAndLoad(
        gAiWindow.gBrowser.selectedBrowser,
        TEST_PAGE_1
      );
    });

    afterEach(async () => {
      gRestoreSignIn();
      await SpecialPowers.popPrefEnv();
    });

    it("should create a user message with a context chip label matching the site", async () => {
      const sidebarBrowser =
        gAiWindow.document.getElementById("ai-window-browser");

      await BrowserTestUtils.waitForCondition(
        () =>
          sidebarBrowser.contentDocument?.querySelector("ai-window:defined"),
        "Sidebar ai-window should be loaded"
      );

      await typeInSmartbar(sidebarBrowser, "test");
      await submitSmartbar(sidebarBrowser);

      const aiWindowEl =
        sidebarBrowser.contentDocument.querySelector("ai-window");
      const aichatBrowser = await BrowserTestUtils.waitForCondition(
        () => aiWindowEl.shadowRoot?.querySelector("#aichat-browser"),
        "Wait for aichat-browser"
      );

      const chipLabel = await SpecialPowers.spawn(
        aichatBrowser,
        [],
        async () => {
          const chatContent = await ContentTaskUtils.waitForCondition(
            () => content.document.querySelector("ai-chat-content"),
            "Wait for ai-chat-content"
          );

          const userChipContainer = await ContentTaskUtils.waitForCondition(
            () =>
              chatContent.shadowRoot.querySelector(
                ".chat-bubble-user website-chip-container"
              ),
            "Wait for user message context chip container"
          );
          const chip = await ContentTaskUtils.waitForCondition(
            () => userChipContainer.shadowRoot.querySelector("ai-website-chip"),
            "Wait for context chip to render"
          );
          return (
            chip.shadowRoot?.querySelector(".chip-label")?.textContent ?? ""
          );
        }
      );

      Assert.equal(
        chipLabel,
        "Example Domain",
        `Expected user message context chip labeled 'Example Domain', got: ${chipLabel}`
      );
    });
  });
});
