/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setAndLockPref } from "resource:///modules/policies/Policies.sys.mjs";
import {
  CHAT_PROVIDERS_DEFAULT,
  GenAI,
} from "resource:///modules/GenAI.sys.mjs";

export const SidebarChatPolicies = {
  configureProviders(policy) {
    const idToName = new Map(
      [...GenAI.chatProviders.values()].map(c => [c.id, c.name])
    );

    let providerIds = CHAT_PROVIDERS_DEFAULT.split(",").filter(
      id => !policy.BuiltIn || policy.BuiltIn[idToName.get(id)] !== false
    );

    policy.Add?.forEach(engine => {
      const url = engine.url.href || engine.url;
      const engineConfig = { id: engine.id, name: engine.name };
      ["iconUrl", "queryParam"].forEach(prop => {
        if (engine[prop] !== undefined) {
          engineConfig[prop] = engine[prop];
        }
      });
      GenAI.chatProviders.set(url, engineConfig);
      providerIds.push(engine.id);
    });

    if (policy.BuiltIn || policy.Add?.length) {
      Services.prefs.setStringPref(
        "browser.ml.chat.providers",
        providerIds.join(",")
      );
    }

    // If there are no providers, disable the chat sidebar
    if (!providerIds.length) {
      setAndLockPref("browser.ml.chat.enabled", false);
    }
  },

  configurePrompts(policy) {
    if (policy.Enabled === false) {
      for (const pref of Services.prefs.getChildList(
        "browser.ml.chat.prompts."
      )) {
        Services.prefs.setStringPref(pref, "");
      }
      setAndLockPref("browser.ml.chat.shortcuts", false);
      return;
    }

    if (!policy.BuiltIn) {
      return;
    }

    const PROMPT_NAME_TO_ID = {
      Summarize: "summarize",
      Explain: "explain",
      Quiz: "quiz",
      Proofread: "proofread",
    };

    const disabledIds = new Set(
      Object.entries(policy.BuiltIn)
        .filter(([, enabled]) => enabled === false)
        .map(([name]) => PROMPT_NAME_TO_ID[name])
        .filter(Boolean)
    );

    if (!disabledIds.size) {
      return;
    }

    for (const pref of Services.prefs.getChildList(
      "browser.ml.chat.prompts."
    )) {
      const value = Services.prefs.getStringPref(pref, "");
      if (!value) {
        continue;
      }
      let promptObj;
      try {
        promptObj = JSON.parse(value);
      } catch (e) {
        continue;
      }
      if (disabledIds.has(promptObj.id)) {
        Services.prefs.setStringPref(pref, "");
      }
    }
  },

  /**
   * Set the default provider
   *
   * @param {object} policy - The policy configuration
   * @param {string} policy.Default - Provider ID to set as default
   */
  setDefaultProvider(policy) {
    if (!policy.Default) {
      return;
    }

    // Find URL for this provider ID
    for (const [url, config] of GenAI.chatProviders) {
      if (config.name === policy.Default) {
        Services.prefs.setStringPref("browser.ml.chat.provider", url);
        break;
      }
    }
  },

  /**
   * Apply SidebarChat policy configuration
   *
   * @param {object} param - The policy parameter
   */
  applySidebarChatPolicy(param) {
    if (param.Providers) {
      this.configureProviders(param.Providers);
      this.setDefaultProvider(param.Providers);
    }
    if (param.Prompts) {
      this.configurePrompts(param.Prompts);
    }
  },

  unapplySidebarChatPolicy() {
    Services.prefs.clearUserPref("browser.ml.chat.providers");
    Services.prefs.clearUserPref("browser.ml.chat.provider");
    Services.prefs.clearUserPref("browser.ml.chat.prompts.0");
    Services.prefs.clearUserPref("browser.ml.chat.prompts.1");
    Services.prefs.clearUserPref("browser.ml.chat.prompts.2");
    Services.prefs.clearUserPref("browser.ml.chat.prompts.3");
  }
};
