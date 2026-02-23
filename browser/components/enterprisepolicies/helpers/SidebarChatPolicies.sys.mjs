/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  GenAI: "resource:///modules/GenAI.sys.mjs",
});

import { setAndLockPref } from "resource:///modules/policies/Policies.sys.mjs";

export let SidebarChatPolicies = {
  /**
   * Remove AI providers based on policy configuration
   *
   * @param {object} policy - The policy configuration
   * @param {boolean} policy.RemoveAll - Whether to remove all built-in providers
   * @param {Array<string>} policy.Remove - Array of provider IDs to remove
   */
  removeProviders(policy) {
    if (policy.RemoveAll) {
      lazy.GenAI.chatProviders.clear();
    } else if (policy.Remove) {
      policy.Remove.forEach(id => {
        for (const [url, config] of lazy.GenAI.chatProviders) {
          if (config.id === id) {
            lazy.GenAI.chatProviders.delete(url);
            break;
          }
        }
      });
    }
  },

  /**
   * Add custom AI providers based on policy configuration
   *
   * @param {object} policy - The policy configuration
   * @param {Array<object>} policy.Add - Array of provider configurations to add
   */
  addProviders(policy) {
    policy.Add.forEach(engine => {
      // Policy system parses URLs and provides them as URL objects
      const url = engine.url.href || engine.url;

      const engineConfig = {
        id: engine.id,
        name: engine.name,
      };

      // Copy optional properties
      const optionalProps = ["iconUrl", "queryParam"];

      optionalProps.forEach(prop => {
        if (engine[prop] !== undefined) {
          engineConfig[prop] = engine[prop];
        }
      });

      lazy.GenAI.chatProviders.set(url, engineConfig);
    });
  },

  /**
   * Remove prompts based on policy configuration
   *
   * @param {object} policy - The policy configuration
   * @param {boolean} policy.RemoveAllPrompts - Whether to remove all prompts
   * @param {Array<string>} policy.RemovePrompts - Array of prompt IDs to remove
   */
  removePrompts(policy) {
    if (policy.RemoveAll) {
      Services.prefs.getChildList("browser.ml.chat.prompts.").forEach(pref => {
        setAndLockPref(pref, "");
      });
      if (!policy.Prompts) {
        // If we are not adding prompts, turn it off completely
        setAndLockPref("browser.ml.chat.page", false);
      }
    }

    if (!policy.Remove?.length) {
      return;
    }
    const promptPrefs = Services.prefs.getChildList("browser.ml.chat.prompts.");

    for (const pref of promptPrefs) {
      const value = Services.prefs.getStringPref(pref, "");
      if (!value) {
        continue; // already cleared or not set
      }

      let promptObj;
      try {
        promptObj = JSON.parse(value);
      } catch (e) {
        continue; // skip invalid JSON
      }

      if (policy.Remove.includes(promptObj.id)) {
        setAndLockPref(pref, "");
      }
    }
  },

  /**
   * Set the default provider and optionally lock the configuration
   *
   * @param {object} policy - The policy configuration
   * @param {string} policy.Default - Provider ID to set as default
   */
  setDefaultProvider(policy) {
    if (!policy.Default) {
      return;
    }

    // Find URL for this provider ID
    for (const [url, config] of lazy.GenAI.chatProviders) {
      if (config.id === policy.Default) {
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
    if (!param) {
      return;
    }

    // Apply policy in order:
    // 1. Remove providers
    // 2. Add custom providers
    // 3. Remove prompts
    // 4. Set default and lock

    if (param.Providers) {
      this.removeProviders(param.Providers);
      this.addProviders(param.Providers);
      this.setDefaultProvider(param.Providers);
    }
    if (param.Prompts) {
      this.removePrompts(param.Prompts);
    }
  },
};
