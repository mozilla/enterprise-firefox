/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  setAndLockPref,
  unsetAndUnlockPref,
  PoliciesUtils,
} from "resource:///modules/policies/Policies.sys.mjs";
import {
  CHAT_PROVIDERS_DEFAULT,
  GenAI,
} from "resource:///modules/GenAI.sys.mjs";

export const AIChatbotPolicies = {
  /**
   * Configure available chat providers based on policy.
   *
   * Filters built-in providers, adds custom providers, and updates the
   * `browser.ml.chat.providers` pref. If no providers remain after filtering,
   * the chat sidebar is disabled entirely.
   *
   * @param {object} providers - The Providers policy object.
   * @param {object} [providers.BuiltIn] - Map of built-in provider names to
   *   booleans. Set a provider to `false` to exclude it.
   * @param {Array<object>} [providers.Add] - Custom providers to add. Each entry
   *   must have `id`, `name`, and `url` properties, and may include
   *   `iconUrl` and `queryParam`.
   */
  configureProviders(providers) {
    const idToName = new Map(
      [...GenAI.chatProviders.values()].map(c => [c.id, c.name])
    );

    let providerIds = CHAT_PROVIDERS_DEFAULT.split(",");
    if (providers.BuiltIn) {
      providerIds = providerIds.filter(
        id => providers.BuiltIn[idToName.get(id)] !== false
      );
    }

    providers.Add?.forEach(engine => {
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

    if (providers.BuiltIn || providers.Add?.length) {
      PoliciesUtils.setDefaultPref(
        "browser.ml.chat.providers",
        providerIds.join(",")
      );
    }

    // If there are no providers, disable the chat sidebar
    if (!providerIds.length) {
      setAndLockPref("browser.ml.chat.enabled", false);
    }
  },

  /**
   * Configure available chat prompts based on policy.
   *
   * If `Enabled` is `false`, clears all prompt prefs and disables the
   * shortcuts feature. Otherwise, removes individual built-in prompts whose
   * names are mapped to `false` in `prompts.BuiltIn`.
   *
   * @param {object} prompts - The Prompts policy object.
   * @param {boolean} [prompts.Enabled] - Set to `false` to disable all prompts
   *   and shortcuts.
   * @param {object} [prompts.BuiltIn] - Map of built-in prompt names
   *   (Summarize, Explain, Quiz, Proofread) to booleans. Set to `false` to
   *   remove the prompt.
   */
  configurePrompts(prompts) {
    if (prompts.Enabled === false) {
      for (const pref of Services.prefs.getChildList(
        "browser.ml.chat.prompts."
      )) {
        PoliciesUtils.setDefaultPref(pref, "");
      }
      PoliciesUtils.setDefaultPref("browser.ml.chat.shortcuts", false);
      return;
    }

    if (!prompts.BuiltIn) {
      return;
    }

    const PROMPT_NAME_TO_ID = {
      Summarize: "summarize",
      Explain: "explain",
      Quiz: "quiz",
      Proofread: "proofread",
    };

    const disabledIds = new Set(
      Object.entries(prompts.BuiltIn)
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
        PoliciesUtils.setDefaultPref(pref, "");
      }
    }
  },

  /**
   * Set the default chat provider by looking up its URL in `GenAI.chatProviders`
   * and writing it to `browser.ml.chat.provider`.
   *
   * @param {string} defaultProvider - Display name of the provider to set as
   *   default. Must match the `name` of an entry in `GenAI.chatProviders`.
   */
  setDefaultProvider(defaultProvider) {
    // Find URL for this provider ID
    for (const [url, config] of GenAI.chatProviders) {
      if (config.name === defaultProvider) {
        PoliciesUtils.setDefaultPref("browser.ml.chat.provider", url);
        break;
      }
    }
  },

  /**
   * Entry point for applying the SidebarChat enterprise policy.
   *
   * Delegates to `configureProviders`/`setDefaultProvider` when
   * `param.Providers` is present, and to `configurePrompts` when
   * `param.Prompts` is present.
   *
   * @param {object} param - The top-level SidebarChat policy object.
   * @param {object} [param.Providers] - Passed to `configureProviders`.
   *   `param.Providers.Default` is passed to `setDefaultProvider` if present.
   * @param {object} [param.Prompts] - Passed to `configurePrompts`.
   */
  applySidebarChatPolicy(param) {
    if (param.Providers) {
      this.configureProviders(param.Providers);
      if (param.Providers.Default) {
        this.setDefaultProvider(param.Providers.Default);
      }
    }
    if (param.Prompts) {
      this.configurePrompts(param.Prompts);
    }
  },

  /**
   * Revert all prefs set by the SidebarChat policy back to their defaults.
   *
   * Called when the policy is removed or the browser is reset to an
   * unenrolled state.
   */
  unapplySidebarChatPolicy() {
    // Can't use unsetDefaultPref for this one because it's empty by default.
    PoliciesUtils.setDefaultPref(
      "browser.ml.chat.providers",
      CHAT_PROVIDERS_DEFAULT
    );
    PoliciesUtils.unsetDefaultPref("browser.ml.chat.provider");
    PoliciesUtils.unsetDefaultPref("browser.ml.chat.prompts.0");
    PoliciesUtils.unsetDefaultPref("browser.ml.chat.prompts.1");
    PoliciesUtils.unsetDefaultPref("browser.ml.chat.prompts.2");
    PoliciesUtils.unsetDefaultPref("browser.ml.chat.prompts.3");
    PoliciesUtils.unsetDefaultPref("browser.ml.chat.shortcuts");
    unsetAndUnlockPref("browser.ml.chat.enabled");
  },
};
