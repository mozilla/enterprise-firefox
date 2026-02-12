/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/assistant-message-footer.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/chat-assistant-error.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/chat-assistant-loader.mjs";

/**
 * A custom element for managing AI Chat Content
 */
export class AIChatContent extends MozLitElement {
  static properties = {
    assistantIsLoading: { type: Boolean },
    conversationState: { type: Array },
    errorStatus: { type: String },
    isSearching: { type: Boolean },
    searchQuery: { type: String },
    showErrorMessage: { type: Boolean },
    tokens: { type: Object },
  };

  constructor() {
    super();
    this.assistantIsLoading = false;
    this.conversationState = [];
    this.errorStatus = null;
    this.isSearching = false;
    this.searchQuery = null;
    this.showErrorMessage = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#initEventListeners();

    this.dispatchEvent(
      new CustomEvent("AIChatContent:Ready", { bubbles: true })
    );
    this.#initFooterActionListeners();
  }

  #dispatchFooterAction(action, detail) {
    this.dispatchEvent(
      new CustomEvent("AIChatContent:DispatchFooterAction", {
        bubbles: true,
        composed: true,
        detail: {
          action,
          ...(detail ?? {}),
        },
      })
    );
  }

  /**
   * Initialize event listeners for AI chat content events
   */

  #initEventListeners() {
    this.addEventListener(
      "aiChatContentActor:message",
      this.messageEvent.bind(this)
    );

    this.addEventListener(
      "aiChatContentActor:truncate",
      this.truncateEvent.bind(this)
    );

    this.addEventListener(
      "aiChatContentActor:remove-applied-memory",
      this.removeAppliedMemoryEvent.bind(this)
    );
  }

  /**
   * Initialize event listeners for footer actions (retry, copy, etc.)
   * emitted by child components.
   */

  #initFooterActionListeners() {
    this.addEventListener("copy-message", event => {
      const { messageId } = event.detail ?? {};
      const text = this.#getAssistantMessageBody(messageId);
      this.#dispatchFooterAction("copy", { messageId, text });
    });

    this.addEventListener("retry-message", event => {
      this.#dispatchFooterAction("retry", event.detail);
    });

    this.addEventListener("retry-without-memories", event => {
      this.#dispatchFooterAction("retry-without-memories", event.detail);
    });

    this.addEventListener("remove-applied-memory", event => {
      this.#dispatchFooterAction("remove-applied-memory", event.detail);
    });
  }

  #getAssistantMessageBody(messageId) {
    if (!messageId) {
      return "";
    }

    const msg = this.conversationState.find(m => {
      return m?.role === "assistant" && m?.messageId === messageId;
    });

    return msg?.body ?? "";
  }

  messageEvent(event) {
    const message = event.detail;

    if (message?.content?.isError) {
      this.handleErrorEvent(message?.content?.status);
      return;
    }

    this.showErrorMessage = false;
    this.#checkConversationState(message);

    switch (message.role) {
      case "loading":
        this.handleLoadingEvent(event);
        break;
      case "assistant":
        this.#checkConversationState(message);
        this.handleAIResponseEvent(event);
        break;
      case "user":
        this.#checkConversationState(message);
        this.handleUserPromptEvent(event);
        break;
      // Used to clear the conversation state via side effects ( new conv id )
      case "clear-conversation":
        this.#checkConversationState(message);
    }
  }

  /**
   * Check if conversationState needs to be cleared
   *
   * @param {ChatMessage} message
   */
  #checkConversationState(message) {
    const lastMessage = this.conversationState.at(-1);
    const firstMessage = this.conversationState.at(0);
    const isReloadingSameConvo =
      firstMessage &&
      firstMessage.convId === message.convId &&
      firstMessage.ordinal === message.ordinal;
    const convIdChanged = message.convId !== lastMessage?.convId;

    // If the conversation ID has changed, reset the conversation state
    if (convIdChanged || isReloadingSameConvo) {
      this.conversationState = [];
    }
  }

  handleLoadingEvent(event) {
    const { isSearching } = event.detail;
    this.isSearching = !!isSearching;
    this.assistantIsLoading = true;
    this.requestUpdate();
    this.#scrollToBottom();
  }

  handleErrorEvent(errorStatus) {
    this.errorStatus = errorStatus;
    this.showErrorMessage = true;
    this.requestUpdate();
  }

  /**
   *  Handle user prompt events
   *
   * @param {CustomEvent} event - The custom event containing the user prompt
   */

  handleUserPromptEvent(event) {
    const { convId, content, ordinal } = event.detail;
    this.assistantIsLoading = true;
    this.conversationState[ordinal] = {
      role: "user",
      body: content.body,
      convId,
      ordinal,
    };
    this.requestUpdate();
    this.#scrollToBottom();
  }

  /**
   * Handle AI response events
   *
   * @param {CustomEvent} event - The custom event containing the response
   */

  handleAIResponseEvent(event) {
    this.isSearching = false;
    this.assistantIsLoading = false;

    const {
      convId,
      ordinal,
      id: messageId,
      content,
      memoriesApplied,
      tokens,
      webSearchQueries,
    } = event.detail;

    if (typeof content.body !== "string" || !content.body) {
      return;
    }

    this.conversationState[ordinal] = {
      role: "assistant",
      convId,
      messageId,
      body: content.body,
      appliedMemories: memoriesApplied ?? [],
      // The "webSearchQueries" are coming from a conversation that is being initialized
      // and "tokens" are streaming in from a live conversation.
      searchTokens: webSearchQueries ?? tokens?.search ?? [],
    };

    this.requestUpdate();
  }

  #scrollToBottom() {
    this.updateComplete.then(() => {
      const wrapper = this.shadowRoot?.querySelector(".chat-content-wrapper");
      if (wrapper) {
        wrapper.scrollTop = wrapper.scrollHeight;
      }
    });
  }

  truncateEvent(event) {
    const { messageId } = event.detail ?? {};
    if (!messageId) {
      return;
    }

    const idx = this.conversationState.findIndex(m => {
      return m?.role === "assistant" && m?.messageId === messageId;
    });

    if (idx === -1) {
      return;
    }

    this.conversationState = this.conversationState.slice(0, idx);
    this.requestUpdate();
  }

  removeAppliedMemoryEvent(event) {
    const { messageId, memoryId } = event.detail ?? {};
    const msg = this.conversationState.find(m => {
      return m?.role === "assistant" && m?.messageId === messageId;
    });

    msg.appliedMemories = msg.appliedMemories.filter(
      memory => memory?.id !== memoryId
    );
    this.requestUpdate();
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/ai-chat-content.css"
      />
      <div class="chat-content-wrapper">
        ${this.conversationState.map(msg => {
          if (!msg) {
            return nothing;
          }
          return html`
            <div class=${`chat-bubble chat-bubble-${msg.role}`}>
              <ai-chat-message
                .message=${msg.body}
                .role=${msg.role}
                .searchTokens=${msg.searchTokens || []}
              ></ai-chat-message>

              ${msg.role === "assistant"
                ? html`
                    <assistant-message-footer
                      .messageId=${msg.messageId}
                      .appliedMemories=${msg.appliedMemories}
                    ></assistant-message-footer>
                  `
                : nothing}
            </div>
          `;
        })}
        ${this.assistantIsLoading
          ? html`<chat-assistant-loader
              .isSearch=${this.isSearching}
            ></chat-assistant-loader>`
          : nothing}
        ${this.showErrorMessage
          ? html`<chat-assistant-error
              .errorStatus=${this.errorStatus}
            ></chat-assistant-error>`
          : nothing}
      </div>
    `;
  }
}

customElements.define("ai-chat-content", AIChatContent);
