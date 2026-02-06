/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

import { ToolRoleOpts } from "moz-src:///browser/components/aiwindow/ui/modules/ChatMessage.sys.mjs";
import {
  MODEL_FEATURES,
  openAIEngine,
} from "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs";
import {
  toolsConfig,
  getOpenTabs,
  searchBrowsingHistory,
  GetPageContent,
  RunSearch,
} from "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});

/**
 * Chat
 */
export const Chat = {};

XPCOMUtils.defineLazyPreferenceGetter(
  Chat,
  "modelId",
  "browser.smartwindow.model",
  "qwen3-235b-a22b-instruct-2507-maas"
);

Object.assign(Chat, {
  toolMap: {
    get_open_tabs: getOpenTabs,
    search_browsing_history: searchBrowsingHistory,
    get_page_content: GetPageContent.getPageContent,
    run_search: RunSearch.runSearch.bind(RunSearch),
  },

  /**
   * Stream assistant output with tool-call support.
   * Yields assistant text chunks as they arrive. If the model issues tool calls,
   * we execute them locally, append results to the conversation, and continue
   * streaming the model’s follow-up answer. Repeats until no more tool calls.
   *
   * @param {ChatConversation} conversation
   * @param {object} [context]
   * @param {Window} [context.win]
   * @yields {string} Assistant text chunks
   */
  async *fetchWithHistory(conversation, context = {}) {
    // Note FXA token fetching disabled for now - this is still in progress
    // We can flip this switch on when more realiable
    const fxAccountToken = await openAIEngine.getFxAccountToken();

    const toolRoleOpts = new ToolRoleOpts(this.modelId);
    const currentTurn = conversation.currentTurnIndex();
    const engineInstance = await openAIEngine.build(MODEL_FEATURES.CHAT);
    const config = engineInstance.getConfig(engineInstance.feature);
    const inferenceParams = config?.parameters || {};

    // Helper to run the model once (streaming) on current convo
    const streamModelResponse = () =>
      engineInstance.runWithGenerator({
        streamOptions: { enabled: true },
        fxAccountToken,
        tool_choice: "auto",
        tools: toolsConfig,
        args: conversation.getMessagesInOpenAiFormat(),
        ...inferenceParams,
      });

    // Keep calling until the model finishes without requesting tools
    while (true) {
      let pendingToolCalls = null;

      // 1) First pass: stream tokens; capture any toolCalls
      for await (const chunk of streamModelResponse()) {
        // Stream assistant text to the UI
        if (chunk?.text) {
          yield chunk.text;
        }

        // Capture tool calls (do not echo raw tool plumbing to the user)
        if (chunk?.toolCalls?.length) {
          pendingToolCalls = chunk.toolCalls;
        }
      }

      // 2) Watch for tool calls; if none, we are done
      if (!pendingToolCalls || pendingToolCalls.length === 0) {
        return;
      }

      // 3) Build the assistant tool_calls message exactly as expected by the API
      //
      // @todo Bug 2006159 - Implement parallel tool calling
      // Temporarily only include the first tool call due to quality issue
      // with subsequent tool call responses, will include all later once above
      // ticket is resolved.
      const tool_calls = pendingToolCalls.slice(0, 1).map(toolCall => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments || "{}",
        },
      }));
      conversation.addAssistantMessage("function", { tool_calls });

      // Persist conversation state before executing tools
      lazy.AIWindow.chatStore?.updateConversation(conversation).catch(() => {});

      // 4) Execute each tool locally and create a tool message with the result
      // TODO: Temporarily only execute the first tool call, will run all later
      for (const toolCall of pendingToolCalls) {
        const { id, function: functionSpec } = toolCall;
        const name = functionSpec?.name || "";
        let toolParams = {};

        try {
          toolParams = functionSpec?.arguments
            ? JSON.parse(functionSpec.arguments)
            : {};
        } catch {
          const content = {
            tool_call_id: id,
            body: { error: "Invalid JSON arguments" },
          };
          conversation.addToolCallMessage(content, currentTurn, toolRoleOpts);
          continue;
        }

        if (name === "run_search") {
          yield { searching: true, query: toolParams.query };
        }

        let result;
        try {
          // Call the appropriate tool by name
          const toolFunc = this.toolMap[name];
          if (typeof toolFunc !== "function") {
            throw new Error(`No such tool: ${name}`);
          }

          if (Object.keys(toolParams).length) {
            result = await toolFunc(toolParams);
          } else {
            result = await toolFunc();
          }

          // Create special tool call log message to show in the UI log panel
          const content = { tool_call_id: id, body: result, name };
          conversation.addToolCallMessage(content, currentTurn, toolRoleOpts);
        } catch (e) {
          result = { error: `Tool execution failed: ${String(e)}` };
          const content = { tool_call_id: id, body: result };
          conversation.addToolCallMessage(content, currentTurn, toolRoleOpts);
        }

        // Persist after each tool result
        lazy.AIWindow.chatStore
          ?.updateConversation(conversation)
          .catch(() => {});

        // run_search navigates away from the AI page; hand off to the sidebar
        // to continue streaming after the search results are captured.
        if (name === "run_search") {
          const win = context.win || lazy.BrowserWindowTracker.getTopWindow();
          if (win) {
            lazy.AIWindow.openSidebarAndContinue(win, conversation);
          }
          return;
        }

        // Bug 	2006159 - Implement parallel tool calling, remove after implemented
        break;
      }
    }
  },
});
