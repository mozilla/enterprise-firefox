/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

describe("settings ai features", () => {
  let doc, win;

  beforeEach(async function setup() {
    await SpecialPowers.pushPrefEnv({
      set: [["browser.settings-redesign.aiFeatures.enabled", true]],
    });
    await openPreferencesViaOpenPreferencesAPI("general", { leaveOpen: true });
    doc = gBrowser.selectedBrowser.contentDocument;
    win = doc.ownerGlobal;
  });

  afterEach(() => {
    BrowserTestUtils.removeTab(gBrowser.selectedTab);
  });

  async function openAiFeaturePanel() {
    const paneLoaded = waitForPaneChange("ai");
    const categoryButton = doc.getElementById("category-ai-features");
    categoryButton.scrollIntoView();
    EventUtils.synthesizeMouseAtCenter(categoryButton, {}, win);
    await paneLoaded;
  }

  it("can change the chatbot provider value", async () => {
    await SpecialPowers.pushPrefEnv({
      set: [["browser.ml.chat.provider", ""]],
    });

    const categoryButton = doc.getElementById("category-ai-features");
    Assert.ok(categoryButton, "category exists");
    Assert.ok(
      BrowserTestUtils.isVisible(categoryButton),
      "category is visible"
    );

    await openAiFeaturePanel();

    const providerControl = doc.getElementById("chatbotProvider");
    Assert.ok(providerControl, "control exists");
    Assert.ok(
      BrowserTestUtils.isVisible(providerControl),
      "control is visible"
    );
    Assert.equal(
      Services.prefs.getStringPref("browser.ml.chat.provider"),
      "",
      "Pref is empty"
    );

    Assert.equal(providerControl.value, "", "No provider set");

    const settingChanged = waitForSettingChange(providerControl.setting);
    providerControl.focus();
    const pickerOpened = BrowserTestUtils.waitForSelectPopupShown(
      win.docShell.chromeEventHandler.ownerGlobal
    );
    EventUtils.sendKey("space");
    await pickerOpened;
    EventUtils.sendKey("down");
    EventUtils.sendKey("return");
    await settingChanged;

    Assert.notEqual(providerControl.value, "", "Provider changed");
    Assert.notEqual(
      Services.prefs.getStringPref("browser.ml.chat.provider"),
      "",
      "Pref is not empty"
    );

    await gBrowser.ownerGlobal.SidebarController.hide();
  });

  it("hides AI Window when preferences not enabled", async () => {
    await SpecialPowers.pushPrefEnv({
      set: [["browser.aiwindow.preferences.enabled", false]],
    });

    await openAiFeaturePanel();

    const aiWindowItem = doc.getElementById("AIWindowItem");
    const aiWindowFeatures = doc.getElementById("aiFeaturesAIWindowGroup");

    Assert.ok(
      !BrowserTestUtils.isVisible(aiWindowItem),
      "AIWindowItem is hidden when preferences not enabled"
    );
    Assert.ok(
      !BrowserTestUtils.isVisible(aiWindowFeatures),
      "aiWindowFeatures is hidden when preferences not enabled"
    );
  });

  it("shows AI Window activate when preferences enabled and feature not enabled", async () => {
    await SpecialPowers.pushPrefEnv({
      set: [
        ["browser.aiwindow.preferences.enabled", true],
        ["browser.aiwindow.enabled", false],
      ],
    });

    await openAiFeaturePanel();

    const aiWindowItem = doc.getElementById("AIWindowItem");
    Assert.ok(
      BrowserTestUtils.isVisible(aiWindowItem),
      "AIWindowItem is visible when preferences enabled and feature not enabled"
    );
  });

  it("hides AI Window activate when feature enabled", async () => {
    await SpecialPowers.pushPrefEnv({
      set: [
        ["browser.aiwindow.preferences.enabled", true],
        ["browser.aiwindow.enabled", true],
      ],
    });

    await openAiFeaturePanel();

    const aiWindowItem = doc.getElementById("AIWindowItem");
    Assert.ok(
      !BrowserTestUtils.isVisible(aiWindowItem),
      "AIWindowItem is hidden when feature enabled"
    );
  });

  // TODO: Add tests for aiFeaturesAIWindowGroup when Model and Insight options are added
  describe("Smart Window memories", () => {
    async function openSmartWindowPanel() {
      await openAiFeaturePanel();
      const personalizeButton = doc.getElementById(
        "personalizeSmartWindowButton"
      );
      const paneLoaded = waitForPaneChange("personalizeSmartWindow");
      EventUtils.synthesizeMouseAtCenter(personalizeButton, {}, win);
      await paneLoaded;
    }

    async function openManageMemoriesPanel() {
      await openSmartWindowPanel();
      const manageButton = doc.getElementById("manageMemoriesButton");
      const paneLoaded = waitForPaneChange("manageMemories");
      EventUtils.synthesizeMouseAtCenter(manageButton, {}, win);
      await paneLoaded;
    }

    async function populateMemories() {
      const { MemoryStore } = ChromeUtils.importESModule(
        "moz-src:///browser/components/aiwindow/services/MemoryStore.sys.mjs"
      );

      let memoryOne = await MemoryStore.addMemory({
        memory_summary: "Lorem ipsum dolor sit amet 1",
        category: "interests",
        intent: "general",
        score: 5,
      });
      let memoryTwo = await MemoryStore.addMemory({
        memory_summary: "Lorem ipsum dolor sit amet 2",
        category: "habits",
        intent: "general",
        score: 4,
      });

      registerCleanupFunction(async () => {
        for (const { id } of [memoryOne, memoryTwo]) {
          try {
            await MemoryStore.hardDeleteMemory(id);
          } catch (err) {
            console.error("Failed to delete memory:", id, err);
          }
        }
      });

      return { MemoryStore, memories: [memoryOne, memoryTwo] };
    }

    it("shows Personalize Smart Window button when AI Window is enabled", async () => {
      await SpecialPowers.pushPrefEnv({
        set: [
          ["browser.aiwindow.preferences.enabled", true],
          ["browser.aiwindow.enabled", true],
        ],
      });

      await openAiFeaturePanel();

      const personalizeButton = doc.getElementById(
        "personalizeSmartWindowButton"
      );
      Assert.ok(personalizeButton, "Personalize Smart Window button exists");
      Assert.ok(
        BrowserTestUtils.isVisible(personalizeButton),
        "Personalize Smart Window button is visible"
      );
    });

    it("toggles Learn from activity preference", async () => {
      await SpecialPowers.pushPrefEnv({
        set: [
          ["browser.aiwindow.preferences.enabled", true],
          ["browser.aiwindow.enabled", true],
          ["browser.aiwindow.memories", false],
        ],
      });

      await openSmartWindowPanel();

      const learnFromActivity = doc.getElementById("learnFromActivity");
      Assert.ok(!learnFromActivity.checked, "Checkbox is unchecked initially");

      learnFromActivity.scrollIntoView();
      EventUtils.synthesizeMouseAtCenter(learnFromActivity.labelEl, {}, win);
      await learnFromActivity.updateComplete;

      Assert.ok(
        Services.prefs.getBoolPref("browser.aiwindow.memories"),
        "Preference is now true"
      );
      Assert.ok(learnFromActivity.checked, "Checkbox is now checked");
    });

    it("shows empty state when no memories exist", async () => {
      await SpecialPowers.pushPrefEnv({
        set: [
          ["browser.aiwindow.preferences.enabled", true],
          ["browser.aiwindow.enabled", true],
          ["browser.aiwindow.memories", true],
        ],
      });

      await openManageMemoriesPanel();

      const noMemoriesItem = doc.getElementById("no-memories-stored");
      Assert.ok(noMemoriesItem, "No memories item exists");
      Assert.ok(
        BrowserTestUtils.isVisible(noMemoriesItem),
        "No memories item is visible"
      );
    });

    it("shows different empty state when learning is disabled", async () => {
      await SpecialPowers.pushPrefEnv({
        set: [
          ["browser.aiwindow.preferences.enabled", true],
          ["browser.aiwindow.enabled", true],
          ["browser.aiwindow.memories", false],
        ],
      });

      await openManageMemoriesPanel();

      // Force the async setting to refresh after pref change
      const memoriesList = doc.getElementById("memoriesList");
      if (memoriesList?.setting?.config?.asyncSetting) {
        memoriesList.setting.config.asyncSetting.emitChange();
        await new Promise(r => win.requestAnimationFrame(r));
      }

      const noMemoriesItem = doc.getElementById("no-memories-stored");
      Assert.ok(noMemoriesItem, "No memories item exists");

      Assert.equal(
        noMemoriesItem.dataset.l10nId,
        "ai-window-no-memories-learning-off",
        "Shows learning-off empty state l10n ID"
      );
    });

    it("renders memory items when data is present", async () => {
      await SpecialPowers.pushPrefEnv({
        set: [
          ["browser.aiwindow.preferences.enabled", true],
          ["browser.aiwindow.enabled", true],
          ["browser.aiwindow.memories", true],
        ],
      });

      await populateMemories();
      await openManageMemoriesPanel();

      const memoriesList = doc.getElementById("memoriesList");
      await memoriesList.updateComplete;

      const memoryItems = memoriesList.querySelectorAll("[id^='memory-item']");
      Assert.greaterOrEqual(
        memoryItems.length,
        2,
        "At least two memory items are rendered"
      );
    });

    it("can delete an individual memory", async () => {
      await SpecialPowers.pushPrefEnv({
        set: [
          ["browser.aiwindow.preferences.enabled", true],
          ["browser.aiwindow.enabled", true],
          ["browser.aiwindow.memories", true],
        ],
      });

      const { MemoryStore, memories } = await populateMemories();
      const testMemory = memories[0];

      await openManageMemoriesPanel();

      const memoriesList = doc.getElementById("memoriesList");
      await memoriesList.updateComplete;

      const initialMemories = await MemoryStore.getMemories();
      const initialCount = initialMemories.length;

      const deleteButton = memoriesList.querySelector(
        `[memoryId="${testMemory.id}"][action="delete"]`
      );
      Assert.ok(deleteButton, "Delete button exists for the memory");

      EventUtils.synthesizeMouseAtCenter(deleteButton, {}, win);

      await BrowserTestUtils.waitForCondition(async () => {
        const currentMemories = await MemoryStore.getMemories();
        return currentMemories.length < initialCount;
      }, "Waiting for memory to be deleted");

      const remainingMemories = await MemoryStore.getMemories();
      Assert.ok(
        !remainingMemories.find(m => m.id === testMemory.id),
        "Memory was deleted"
      );
    });
  });
});
