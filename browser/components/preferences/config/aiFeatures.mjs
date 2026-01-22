/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";
import { OnDeviceModelManager } from "chrome://browser/content/preferences/OnDeviceModelManager.mjs";

/**
 * @import { OnDeviceModelFeaturesEnum } from "chrome://browser/content/preferences/OnDeviceModelManager.mjs"
 */

const { CommonDialog } = ChromeUtils.importESModule(
  "resource://gre/modules/CommonDialog.sys.mjs"
);

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  GenAI: "resource:///modules/GenAI.sys.mjs",
  log: () =>
    console.createInstance({
      prefix: "aiFeatures",
      maxLogLevel: "Info",
    }),
  MemoryStore:
    "moz-src:///browser/components/aiwindow/services/MemoryStore.sys.mjs",
});

Preferences.addAll([
  { id: "browser.ml.chat.provider", type: "string" },
  { id: "browser.aiwindow.preferences.enabled", type: "bool" },
  { id: "browser.aiwindow.enabled", type: "bool" },
  { id: "browser.aiwindow.memories", type: "bool" },
]);

Preferences.addSetting({ id: "chatbotProviderItem" });
Preferences.addSetting({
  id: "chatbotProvider",
  pref: "browser.ml.chat.provider",
  setup() {
    lazy.GenAI.init();
  },
  getControlConfig(config, _, setting) {
    let providerUrl = setting.value;
    let isKnownProvider = providerUrl == "";
    let options = [config.options[0]];
    lazy.GenAI.chatProviders.forEach((provider, url) => {
      let isSelected = url == providerUrl;
      // @ts-expect-error provider.hidden isn't in the typing
      if (!isSelected && provider.hidden) {
        return;
      }
      isKnownProvider = isKnownProvider || isSelected;
      options.push({
        value: url,
        controlAttrs: { label: provider.name },
      });
    });
    if (!isKnownProvider) {
      options.push({
        value: providerUrl,
        controlAttrs: { label: providerUrl },
      });
    }
    return {
      ...config,
      options,
    };
  },
});
Preferences.addSetting(
  /** @type {{ selected: string } & SettingConfig} */ ({
    id: "onDeviceModel",
    selected: Object.values(OnDeviceModelManager.features)[0],
    getControlConfig(config) {
      if (!config.options) {
        config.options = Object.entries(OnDeviceModelManager.features).map(
          ([key, value]) => ({
            value,
            controlAttrs: { label: key },
          })
        );
      }
      return config;
    },
    get() {
      return this.selected;
    },
    set(val) {
      this.selected = String(val);
    },
  })
);
Preferences.addSetting({
  id: "onDeviceModelInstall",
  deps: ["onDeviceModel"],
  async onUserClick(_, deps) {
    let feature = /** @type {OnDeviceModelFeaturesEnum} */ (
      deps.onDeviceModel.value
    );
    lazy.log.info("Will install: ", feature);
    await OnDeviceModelManager.install(feature);
    lazy.log.info("Done install: ", feature);
  },
});
Preferences.addSetting({
  id: "onDeviceModelUninstall",
  deps: ["onDeviceModel"],
  async onUserClick(_, deps) {
    let feature = /** @type {OnDeviceModelFeaturesEnum} */ (
      deps.onDeviceModel.value
    );
    lazy.log.info("Will uninstall: ", feature);
    await OnDeviceModelManager.uninstall(feature);
    lazy.log.info("Done uninstall: ", feature);
  },
});
Preferences.addSetting({
  id: "onDeviceModelUninstallAll",
  async onUserClick() {
    lazy.log.info("Will uninstall: ALL");
    await Promise.all(
      Object.values(OnDeviceModelManager.features).map(feature =>
        OnDeviceModelManager.uninstall(feature)
      )
    );
    lazy.log.info("Done uninstall: ALL");
  },
});

Preferences.addSetting({
  id: "AIWindowPreferencesEnabled",
  pref: "browser.aiwindow.preferences.enabled",
});

Preferences.addSetting({
  id: "AIWindowEnabled",
  pref: "browser.aiwindow.enabled",
});

// Only show the feature settings if the prefs are allowed to show and the
// feature isn't enabled.
Preferences.addSetting({
  id: "AIWindowItem",
  deps: ["AIWindowEnabled", "AIWindowPreferencesEnabled"],
  visible: deps => {
    return deps.AIWindowPreferencesEnabled.value && !deps.AIWindowEnabled.value;
  },
});
Preferences.addSetting({ id: "AIWindowHeader" });
Preferences.addSetting({ id: "AIWindowActivateLink" });

// Only show the AI Window features if the prefs are allowed to show and the
// feature is enabled.
Preferences.addSetting({
  id: "aiFeaturesAIWindowGroup",
  deps: ["AIWindowEnabled", "AIWindowPreferencesEnabled"],
  visible: deps => {
    return deps.AIWindowPreferencesEnabled.value && deps.AIWindowEnabled.value;
  },
});

Preferences.addSetting({
  id: "personalizeSmartWindowButton",
  onUserClick(e) {
    e.preventDefault();
    window.gotoPref("panePersonalizeSmartWindow");
  },
});

Preferences.addSetting({ id: "learnFromActivityWrapper" });
Preferences.addSetting({
  id: "learnFromActivity",
  pref: "browser.aiwindow.memories",
});

Preferences.addSetting({
  id: "manageMemoriesButton",
  onUserClick(e) {
    e.preventDefault();
    window.gotoPref("manageMemories");
  },
});

Preferences.addSetting({ id: "memories" });

Preferences.addSetting({
  id: "memory-item",
  onUserClick(e) {
    const action = e.target.getAttribute("action");
    const memoryId = e.target.getAttribute("memoryId");
    if (action === "delete") {
      lazy.MemoryStore.hardDeleteMemory(memoryId);
    }
  },
});

Preferences.addSetting({
  id: "deleteAllMemoriesButton",
  async onUserClick() {
    const memories = await lazy.MemoryStore.getMemories();
    if (!memories.length) {
      return;
    }

    const [title, message, deleteButton, cancelButton] =
      await document.l10n.formatValues([
        { id: "ai-window-delete-all-memories-title" },
        { id: "ai-window-delete-all-memories-message" },
        { id: "ai-window-delete-all-memories-confirm" },
        { id: "ai-window-delete-all-memories-cancel" },
      ]);

    const buttonFlags =
      Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
      Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING +
      Services.prompt.BUTTON_POS_0_DEFAULT;

    const result = await Services.prompt.asyncConfirmEx(
      window.browsingContext,
      Services.prompt.MODAL_TYPE_CONTENT,
      title,
      message,
      buttonFlags,
      deleteButton,
      cancelButton,
      null,
      null,
      false,
      {
        useTitle: true,
        headerIconCSSValue: CommonDialog.DEFAULT_APP_ICON_CSS,
      }
    );

    if (result.get("buttonNumClicked") === 0) {
      for (const memory of memories) {
        try {
          await lazy.MemoryStore.hardDeleteMemory(memory.id);
        } catch (err) {
          console.error("Failed to delete memory:", memory.id, err);
        }
      }
    }
  },
});

Preferences.addSetting({ id: "no-memories-stored" });
Preferences.addSetting({ id: "memories-list-header" });

Preferences.addSetting(
  class extends Preferences.AsyncSetting {
    static id = "memoriesList";

    setup() {
      Services.obs.addObserver(this.emitChange, "memory-store-changed");
      Services.prefs.addObserver("browser.aiwindow.memories", this.emitChange);
      return () => {
        Services.obs.removeObserver(this.emitChange, "memory-store-changed");
        Services.prefs.removeObserver(
          "browser.aiwindow.memories",
          this.emitChange
        );
      };
    }

    async getMemories() {
      return lazy.MemoryStore.getMemories();
    }

    async getControlConfig() {
      const memories = await this.getMemories();
      const isLearningEnabled = Services.prefs.getBoolPref(
        "browser.aiwindow.memories",
        false
      );

      if (!memories.length) {
        return {
          items: [
            {
              id: "no-memories-stored",
              l10nId: isLearningEnabled
                ? "ai-window-no-memories"
                : "ai-window-no-memories-learning-off",
              control: "placeholder-message",
            },
          ],
        };
      }

      return {
        items: [
          {
            id: "memories-list-header",
            control: "moz-box-item",
            items: [
              {
                id: "deleteAllMemoriesButton",
                control: "moz-button",
                l10nId: "ai-window-delete-all-memories-button",
                iconSrc: "chrome://global/skin/icons/delete.svg",
              },
            ],
          },
          ...memories.map((memory, index) => ({
            id: `memory-item`,
            key: `memory-${index}`,
            control: "moz-box-item",
            controlAttrs: {
              ".label": memory.memory_summary,
            },
            options: [
              {
                control: "moz-button",
                iconSrc: "chrome://global/skin/icons/delete.svg",
                l10nId: "ai-window-memory-delete-button",
                l10nArgs: { label: memory.memory_summary },
                controlAttrs: {
                  slot: "actions-start",
                  action: "delete",
                  memoryId: memory.id,
                },
              },
            ],
          })),
        ],
      };
    }
  }
);

SettingGroupManager.registerGroups({
  debugModelManagement: {
    l10nId: "debug-model-management-group",
    items: [
      {
        id: "onDeviceModel",
        control: "moz-select",
        l10nId: "debug-model-management-feature",
      },
      {
        id: "onDeviceModelInstall",
        control: "moz-button",
        l10nId: "debug-model-management-install",
      },
      {
        id: "onDeviceModelUninstall",
        control: "moz-button",
        l10nId: "debug-model-management-uninstall",
      },
      {
        id: "onDeviceModelUninstallAll",
        control: "moz-button",
        l10nId: "debug-model-management-uninstall-all",
      },
    ],
  },
  aiFeatures: {
    l10nId: "preferences-ai-controls-sidebar-chatbot-group",
    supportPage: "ai-chatbot",
    items: [
      {
        id: "chatbotProviderItem",
        control: "moz-box-item",
        items: [
          {
            id: "chatbotProvider",
            l10nId: "preferences-ai-controls-sidebar-chatbot-control",
            control: "moz-select",
            options: [
              {
                l10nId: "preferences-ai-controls-state-available",
                value: "",
              },
            ],
          },
        ],
      },
      {
        id: "AIWindowItem",
        control: "moz-box-group",
        items: [
          {
            id: "AIWindowHeader",
            l10nId: "try-ai-features-ai-window",
            control: "moz-box-item",
          },
          {
            id: "AIWindowActivateLink",
            l10nId: "try-ai-features-ai-window-activate-link",
            control: "moz-box-link",
          },
        ],
      },
    ],
  },
  aiWindowFeatures: {
    l10nId: "ai-window-features-group",
    // TODO: Finalize SUMO support page slug (GENAI-3016)
    supportPage: "smart-window",
    items: [
      {
        id: "aiFeaturesAIWindowGroup",
        control: "moz-box-group",
        items: [
          {
            id: "personalizeSmartWindowButton",
            l10nId: "ai-window-personalize-button",
            control: "moz-box-button",
          },
        ],
      },
    ],
  },
  memoriesGroup: {
    l10nId: "ai-window-memories-section",
    headingLevel: 2,
    // TODO: Finalize SUMO support page slug (GENAI-3016)
    supportPage: "smart-window-memories",
    items: [
      {
        id: "memories",
        control: "moz-box-group",
        items: [
          {
            id: "learnFromActivityWrapper",
            control: "moz-box-item",
            items: [
              {
                id: "learnFromActivity",
                l10nId: "ai-window-learn-from-activity",
                control: "moz-checkbox",
              },
            ],
          },
          {
            id: "manageMemoriesButton",
            l10nId: "ai-window-manage-memories-button",
            control: "moz-box-button",
          },
        ],
      },
    ],
  },
  manageMemories: {
    items: [
      {
        id: "memoriesList",
        control: "moz-box-group",
        controlAttrs: {
          type: "list",
        },
      },
    ],
  },
});
