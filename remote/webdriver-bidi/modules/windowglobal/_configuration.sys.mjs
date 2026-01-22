/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WindowGlobalBiDiModule } from "chrome://remote/content/webdriver-bidi/modules/WindowGlobalBiDiModule.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ContextDescriptorType:
    "chrome://remote/content/shared/messagehandler/MessageHandler.sys.mjs",
  RootMessageHandler:
    "chrome://remote/content/shared/messagehandler/RootMessageHandler.sys.mjs",
  WindowGlobalMessageHandler:
    "chrome://remote/content/shared/messagehandler/WindowGlobalMessageHandler.sys.mjs",
});

/**
 * Internal module to set the configuration on the newly created navigables.
 */
class _ConfigurationModule extends WindowGlobalBiDiModule {
  #geolocationConfiguration;
  #preloadScripts;
  #resolveBlockerPromise;
  #viewportConfiguration;

  constructor(messageHandler) {
    super(messageHandler);

    this.#geolocationConfiguration = undefined;
    this.#preloadScripts = new Set();
    this.#viewportConfiguration = new Map();

    Services.obs.addObserver(this, "document-element-inserted");
  }

  destroy() {
    // Unblock the document parsing.
    if (this.#resolveBlockerPromise) {
      this.#resolveBlockerPromise();
    }

    Services.obs.removeObserver(this, "document-element-inserted");

    this.#preloadScripts = null;
    this.#viewportConfiguration = null;
  }

  async observe(subject, topic) {
    if (topic === "document-element-inserted") {
      const window = subject?.defaultView;
      // Ignore events without a window.
      if (window !== this.messageHandler.window) {
        return;
      }

      // Do nothing if there is no configuration to apply.
      if (
        this.#preloadScripts.size === 0 &&
        this.#viewportConfiguration.size === 0 &&
        this.#geolocationConfiguration === undefined
      ) {
        this.#onConfigurationComplete(window);
        return;
      }

      // Block document parsing.
      const blockerPromise = new Promise(resolve => {
        this.#resolveBlockerPromise = resolve;
      });
      window.document.blockParsing(blockerPromise);

      // Usually rendering is blocked until layout is started implicitly (by
      // end of parsing) or explicitly. Since we block the implicit
      // initialization and some code we call may block on it (like waiting for
      // requestAnimationFrame or viewport dimensions), we initialize it
      // explicitly here by forcing a layout flush. Note that this will cause
      // flashes of unstyled content, but that was already the case before
      // bug 1958942.
      window.document.documentElement.getBoundingClientRect();

      if (this.#geolocationConfiguration !== undefined) {
        await this.messageHandler.handleCommand({
          moduleName: "emulation",
          commandName: "_setGeolocationOverride",
          destination: {
            type: lazy.WindowGlobalMessageHandler.type,
            id: this.messageHandler.context.id,
          },
          params: {
            coordinates: this.#geolocationConfiguration,
          },
        });
      }

      if (this.#viewportConfiguration.size !== 0) {
        await this.messageHandler.forwardCommand({
          moduleName: "browsingContext",
          commandName: "_updateNavigableViewport",
          destination: {
            type: lazy.RootMessageHandler.type,
          },
          params: {
            navigable: this.messageHandler.context,
            viewportOverride: Object.fromEntries(this.#viewportConfiguration),
          },
        });
      }

      if (this.#preloadScripts.size !== 0) {
        await this.messageHandler.handleCommand({
          moduleName: "script",
          commandName: "_evaluatePreloadScripts",
          destination: {
            type: lazy.WindowGlobalMessageHandler.type,
            id: this.messageHandler.context.id,
          },
          params: {
            scripts: this.#preloadScripts,
          },
        });
      }

      // Continue script parsing.
      this.#resolveBlockerPromise();
      this.#onConfigurationComplete(window);
    }
  }

  async #onConfigurationComplete(window) {
    // parser blocking doesn't work for initial about:blank, so ensure
    // browsing_context.create waits for configuration to complete
    if (window.document.isInitialDocument) {
      await this.messageHandler.forwardCommand({
        moduleName: "browsingContext",
        commandName: "_onConfigurationComplete",
        destination: {
          type: lazy.RootMessageHandler.type,
        },
        params: {
          navigable: this.messageHandler.context,
        },
      });
    }
  }

  #updatePreloadScripts(sessionData) {
    this.#preloadScripts.clear();

    for (const { contextDescriptor, value } of sessionData) {
      if (!this.messageHandler.matchesContext(contextDescriptor)) {
        continue;
      }

      this.#preloadScripts.add(value);
    }
  }

  /**
   * Internal commands
   */

  _applySessionData(params) {
    const { category, sessionData } = params;

    if (category === "preload-script") {
      this.#updatePreloadScripts(sessionData);
    }

    // The following overrides apply only to top-level traversables.
    if (
      ["geolocation-override", "viewport-overrides"].includes(category) &&
      !this.messageHandler.context.parent
    ) {
      let geolocationOverridePerContext = null;
      let geolocationOverridePerUserContext = null;

      for (const { contextDescriptor, value } of sessionData) {
        if (!this.messageHandler.matchesContext(contextDescriptor)) {
          continue;
        }

        switch (category) {
          case "geolocation-override": {
            switch (contextDescriptor.type) {
              case lazy.ContextDescriptorType.TopBrowsingContext: {
                geolocationOverridePerContext = value;
                break;
              }
              case lazy.ContextDescriptorType.UserContext: {
                geolocationOverridePerUserContext = value;
                break;
              }
            }
            break;
          }
          case "viewport-overrides": {
            if (value.viewport !== undefined) {
              this.#viewportConfiguration.set("viewport", value.viewport);
            }

            if (value.devicePixelRatio !== undefined) {
              this.#viewportConfiguration.set(
                "devicePixelRatio",
                value.devicePixelRatio
              );
            }
            break;
          }
        }
      }

      // For the geolocation emulations on the previous step, we found session items
      // that would apply an override for a browsing context,a user context, and in some cases globally.
      // Now from these items we have to choose the one that would take precedence.
      // The order is the user context item overrides the global one, and the browsing context overrides the user context item.
      if (category === "geolocation-override") {
        if (
          typeof geolocationOverridePerContext === "object" &&
          geolocationOverridePerContext !== null
        ) {
          this.#geolocationConfiguration = geolocationOverridePerContext;
        } else if (
          typeof geolocationOverridePerUserContext === "object" &&
          geolocationOverridePerUserContext !== null
        ) {
          this.#geolocationConfiguration = geolocationOverridePerUserContext;
        }
      }
    }
  }
}

export const _configuration = _ConfigurationModule;
