/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { RootBiDiModule } from "chrome://remote/content/webdriver-bidi/modules/RootBiDiModule.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowsingContextListener:
    "chrome://remote/content/shared/listeners/BrowsingContextListener.sys.mjs",
  ContextDescriptorType:
    "chrome://remote/content/shared/messagehandler/MessageHandler.sys.mjs",
  RootMessageHandler:
    "chrome://remote/content/shared/messagehandler/RootMessageHandler.sys.mjs",
});

// Apply here only the emulations that will be initialized in the parent process,
// except from `viewport-overrides` which is handled separately.
const EMULATIONS_TO_APPLY = [
  "locale-override",
  "screen-orientation-override",
  "screen-settings-override",
  "timezone-override",
  "user-agent-override",
];

/**
 * Internal module to set the configuration on the newly created navigables.
 */
class _ConfigurationModule extends RootBiDiModule {
  #configurationMap;
  #contextListener;

  constructor(messageHandler) {
    super(messageHandler);

    this.#contextListener = new lazy.BrowsingContextListener();
    this.#contextListener.on("attached", this.#onContextAttached);
    this.#contextListener.startListening();

    // The configuration map, which maps an emulation to the settings
    // that derived from session data when a browsing context is created
    // to define which emulations have to be applied to this browsing context.
    this.#configurationMap = {};
    for (const emulation of EMULATIONS_TO_APPLY) {
      this.#configurationMap[emulation] = {
        [lazy.ContextDescriptorType.TopBrowsingContext]: null,
        [lazy.ContextDescriptorType.UserContext]: null,
      };

      // User agent override also supports a global setting.
      // see https://www.w3.org/TR/webdriver-bidi/#command-emulation-setUserAgentOverride.
      if (emulation === "user-agent-override") {
        this.#configurationMap["user-agent-override"][
          lazy.ContextDescriptorType.All
        ] = null;
      }
    }
  }

  destroy() {
    this.#contextListener.stopListening();
    this.#contextListener.off("attached", this.#onContextAttached);
    this.#contextListener.destroy();

    this.#configurationMap = null;
  }

  // For some emulations a value set per a browsing context overrides
  // a value set per a user context or set globally. And a value set per
  // a user context overrides a global value.
  #findCorrectOverrideValue(configuration, type) {
    const contextValue =
      configuration[lazy.ContextDescriptorType.TopBrowsingContext];
    const userContextValue =
      configuration[lazy.ContextDescriptorType.UserContext];
    const globalValue = configuration[lazy.ContextDescriptorType.All];

    if (this.#isOfType(contextValue, type)) {
      return contextValue;
    }
    if (this.#isOfType(userContextValue, type)) {
      return userContextValue;
    }
    if (this.#isOfType(globalValue, type)) {
      return globalValue;
    }
    return null;
  }

  /**
   * Check if the provided value matches the provided type.
   *
   * @param {*} value
   *     The value to verify.
   * @param {string} type
   *     The type to match.
   *
   * @returns {boolean}
   *     Returns `true` if the value type is the same as
   *     the provided type. `false`, otherwise.
   *     Also always returns `false` for `null`.
   */
  #isOfType(value, type) {
    return typeof value === type && value !== null;
  }

  #onContextAttached = async (eventName, data = {}) => {
    const { browsingContext } = data;

    // We have to apply configuration only to top-level browsing contexts.
    if (browsingContext.parent) {
      return;
    }

    const sessionDataItems =
      this.messageHandler.sessionData.getSessionDataForContext(
        "_configuration",
        undefined,
        browsingContext
      );

    const configurationMap = structuredClone(this.#configurationMap);

    for (const { category, contextDescriptor, value } of sessionDataItems) {
      if (!EMULATIONS_TO_APPLY.includes(category)) {
        continue;
      }

      configurationMap[category][contextDescriptor.type] = value;
    }

    // For the following emulations on the previous step, we found session items
    // that would apply an override for a browsing context, a user context, and in some cases globally.
    // Now from these items we have to choose the one that would take precedence.
    // The order is the user context item overrides the global one, and the browsing context overrides the user context item.
    const localeOverride = this.#findCorrectOverrideValue(
      configurationMap["locale-override"],
      "string"
    );
    const screenOrientationOverride = this.#findCorrectOverrideValue(
      configurationMap["screen-orientation-override"],
      "object"
    );
    const screenSettingsOverride = this.#findCorrectOverrideValue(
      configurationMap["screen-settings-override"],
      "object"
    );
    const timezoneOverride = this.#findCorrectOverrideValue(
      configurationMap["timezone-override"],
      "string"
    );
    const userAgentOverride = this.#findCorrectOverrideValue(
      configurationMap["user-agent-override"],
      "string"
    );

    if (
      localeOverride !== null ||
      screenOrientationOverride !== null ||
      screenSettingsOverride !== null ||
      timezoneOverride !== null ||
      userAgentOverride !== null
    ) {
      await this.messageHandler.handleCommand({
        moduleName: "emulation",
        commandName: "_applyEmulationsToNewBrowsingContext",
        destination: {
          type: lazy.RootMessageHandler.type,
        },
        params: {
          context: browsingContext,
          localeOverride,
          screenOrientationOverride,
          screenSettingsOverride,
          timezoneOverride,
          userAgentOverride,
        },
      });
    }
  };

  /**
   * Internal commands
   */

  _applySessionData() {}
}

export const _configuration = _ConfigurationModule;
