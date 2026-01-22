/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import {
  createParserState,
  consumeStreamChunk,
  flushTokenRemainder,
} from "chrome://browser/content/aiwindow/modules/TokenStreamParser.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Chat: "moz-src:///browser/components/aiwindow/models/Chat.sys.mjs",
  generateChatTitle:
    "moz-src:///browser/components/aiwindow/models/TitleGeneration.sys.mjs",
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  ChatConversation:
    "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs",
  MESSAGE_ROLE:
    "moz-src:///browser/components/aiwindow/ui/modules/ChatEnums.sys.mjs",
  AssistantRoleOpts:
    "moz-src:///browser/components/aiwindow/ui/modules/ChatMessage.sys.mjs",
  getRoleLabel:
    "moz-src:///browser/components/aiwindow/ui/modules/ChatUtils.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", function () {
  return console.createInstance({
    prefix: "ChatStore",
    maxLogLevelPref: "browser.aiwindow.chatStore.loglevel",
  });
});

const FULLPAGE = "fullpage";
const SIDEBAR = "sidebar";

/**
 * A custom element for managing AI Window
 */
export class AIWindow extends MozLitElement {
  static properties = {
    userPrompt: { type: String },
    mode: { type: String }, // sidebar | fullpage
  };

  #browser;
  #smartbar;
  #conversation;
  #visibilityChangeHandler;

  #detectModeFromContext() {
    return window.browsingContext?.embedderElement?.id === "ai-window-browser"
      ? SIDEBAR
      : FULLPAGE;
  }

  constructor() {
    super();

    this.userPrompt = "";
    this.#browser = null;
    this.#smartbar = null;
    this.#conversation = new lazy.ChatConversation({});
    this.mode = this.#detectModeFromContext();
  }

  connectedCallback() {
    super.connectedCallback();
  }

  disconnectedCallback() {
    // Clean up visibility change handler
    if (this.#visibilityChangeHandler) {
      this.ownerDocument.removeEventListener(
        "visibilitychange",
        this.#visibilityChangeHandler
      );
      this.#visibilityChangeHandler = null;
    }

    // Clean up smartbar
    if (this.#smartbar) {
      this.#smartbar.removeEventListener(
        "smartbar-commit",
        this.#handleSmartbarCommit
      );
      this.#smartbar.remove();
      this.#smartbar = null;
    }

    // Clean up browser
    if (this.#browser) {
      this.#browser.remove();
      this.#browser = null;
    }

    // Clean up conversation
    this.#conversation = null;

    super.disconnectedCallback();
  }

  firstUpdated() {
    // Create a real XUL <browser> element from the chrome document
    const doc = this.ownerDocument; // browser.xhtml
    const browser = doc.createXULElement("browser");

    browser.setAttribute("id", "aichat-browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("maychangeremoteness", "true");
    browser.setAttribute("disableglobalhistory", "true");
    browser.setAttribute("src", "about:aichatcontent");
    browser.setAttribute("transparent", "true");

    const container = this.renderRoot.querySelector("#browser-container");
    container.appendChild(browser);

    this.#browser = browser;

    // Defer Smartbar initialization for preloaded documents
    if (doc.hidden) {
      this.#visibilityChangeHandler = () => {
        if (!doc.hidden && !this.#smartbar) {
          this.#getOrCreateSmartbar(doc, container);
        }
      };
      doc.addEventListener("visibilitychange", this.#visibilityChangeHandler, {
        once: true,
      });
    } else {
      this.#getOrCreateSmartbar(doc, container);
    }
  }

  /**
   * Helper method to get or create the smartbar element
   *
   * @param {Document} doc - The document
   * @param {Element} container - The container element
   */
  #getOrCreateSmartbar(doc, container) {
    // Find existing Smartbar or create it when we init the AI Window.
    let smartbar = container.querySelector("#ai-window-smartbar");

    if (!smartbar) {
      // The Smartbar can’t be initialized in the shadow DOM and needs
      // to be created from the chrome document.
      smartbar = doc.createElement("moz-smartbar");
      smartbar.id = "ai-window-smartbar";
      smartbar.setAttribute("sap-name", "smartbar");
      smartbar.setAttribute("pageproxystate", "invalid");
      smartbar.setAttribute("popover", "manual");
      smartbar.classList.add("smartbar", "urlbar");
      container.append(smartbar);

      smartbar.addEventListener("smartbar-commit", this.#handleSmartbarCommit);
    }
    this.#smartbar = smartbar;
  }

  /**
   * Handles the smartbar-commit action for the user prompt
   *
   * @param {CustomEvent} event - The smartbar-commit event
   * @private
   */
  #handleSmartbarCommit = event => {
    const { value, action } = event.detail;
    if (action === "chat") {
      this.userPrompt = value;
      this.#fetchAIResponse();
    }
  };

  /**
   * Persists the current conversation state to the database.
   *
   * @private
   */
  async #updateConversation() {
    await lazy.AIWindow.chatStore
      .updateConversation(this.#conversation)
      .catch(updateError => {
        lazy.log.error(`Error updating conversation: ${updateError.message}`);
      });
  }

  /**
   * Generates and sets a title for the conversation if one doesn't exist.
   *
   * @private
   */
  async #addConversationTitle() {
    if (this.#conversation.title) {
      return;
    }

    const firstUserMessage = this.#conversation.messages.find(
      m => m.role === lazy.MESSAGE_ROLE.USER
    );

    const title = await lazy.generateChatTitle(
      firstUserMessage?.content?.body,
      {
        url: firstUserMessage?.pageUrl?.href || "",
        title: this.#conversation.pageMeta?.title || "",
        description: this.#conversation.pageMeta?.description || "",
      }
    );

    this.#conversation.title = title;
    this.#updateConversation();
  }

  /**
   * Fetches an AI response based on the current user prompt.
   * Validates the prompt, updates conversation state, streams the response,
   * and dispatches updates to the browser actor.
   *
   * @private
   */

  #fetchAIResponse = async () => {
    const formattedPrompt = (this.userPrompt || "").trim();
    if (!formattedPrompt) {
      return;
    }

    // Handle User Prompt
    this.#dispatchMessageToChatContent({
      role: lazy.MESSAGE_ROLE.USER,
      content: {
        body: formattedPrompt,
      },
    });

    const nextTurnIndex = this.#conversation.currentTurnIndex() + 1;
    try {
      const pageUrl = URL.fromURI(
        window.browsingContext.topChromeWindow.gBrowser.currentURI
      );

      const stream = lazy.Chat.fetchWithHistory(
        await this.#conversation.generatePrompt(formattedPrompt, pageUrl)
      );
      this.#updateConversation();
      this.#addConversationTitle();
      this.userPrompt = "";

      // @todo
      // fill out these assistant message flags
      const assistantRoleOpts = new lazy.AssistantRoleOpts();
      this.#conversation.addAssistantMessage(
        "text",
        "",
        nextTurnIndex,
        assistantRoleOpts
      );

      const parserState = createParserState();
      const currentMessage = this.#conversation.messages
        .filter(message => message.role === lazy.MESSAGE_ROLE.ASSISTANT)
        .at(-1);

      for await (const chunk of stream) {
        const { plainText, tokens } = consumeStreamChunk(chunk, parserState);

        if (!currentMessage.tokens) {
          currentMessage.tokens = {
            search: [],
            existing_memory: [],
          };
        }

        if (plainText) {
          currentMessage.content.body += plainText;
        }

        if (tokens?.length) {
          tokens.forEach(token => {
            currentMessage.tokens[token.key].push(token.value);
          });
        }

        this.#updateConversation();
        this.#dispatchMessageToChatContent(currentMessage);
        this.requestUpdate?.();
      }

      // End of stream: if there was an unclosed §... treat as literal text
      const remainder = flushTokenRemainder(parserState);

      if (remainder) {
        currentMessage.content.body += remainder;
        this.#updateConversation();
        this.#dispatchMessageToChatContent(currentMessage);
        this.requestUpdate?.();
      }
    } catch (e) {
      // TODO - handle error properly
      this.requestUpdate?.();
    }
  };

  /**
   * Retrieves the AIChatContent actor from the browser's window global.
   *
   * @returns {Promise<object|null>} The AIChatContent actor, or null if unavailable.
   * @private
   */

  #getAIChatContentActor() {
    if (!this.#browser) {
      lazy.log.warn("AI browser not set, cannot get AIChatContent actor");
      return null;
    }

    const windowGlobal = this.#browser.browsingContext?.currentWindowGlobal;

    if (!windowGlobal) {
      lazy.log.warn("No window global found for AI browser");
      return null;
    }

    try {
      return windowGlobal.getActor("AIChatContent");
    } catch (error) {
      lazy.log.error("Failed to get AIChatContent actor:", error);
      return null;
    }
  }

  /**
   * Dispatches a message to the AIChatContent actor.
   *
   * @param {ChatMessage} message - message to dispatch to chat content actor
   * @returns
   */

  #dispatchMessageToChatContent(message) {
    const actor = this.#getAIChatContentActor();

    const newMessage = { ...message };
    if (typeof message.role !== "string") {
      const roleLabel = lazy.getRoleLabel(newMessage.role).toLowerCase();
      newMessage.role = roleLabel;
    }

    if (!actor) {
      return null;
    }

    return actor.dispatchMessageToChatContent(newMessage);
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/ai-window.css"
      />
      <!-- TODO (Bug 2008938): Make in-page Smartbar styling not dependent on chrome styles -->
      <link rel="stylesheet" href="chrome://browser/skin/smartbar.css" />
      <div id="browser-container"></div>
      <!-- TODO : Example of mode-based rendering -->
      ${this.mode === FULLPAGE ? html`<div>Fullpage Footer Content</div>` : ""}
    `;
  }
}

customElements.define("ai-window", AIWindow);
