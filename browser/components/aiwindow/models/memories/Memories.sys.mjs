/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * This module defines functions to generate, deduplicate, and filter memories.
 *
 * The primary method is `runSessionMemoryPipeline`, which orchestrates the
 * pipeline over a batch of unified session bundles (see `buildSessions`):
 * 1. Generates initial memories, one LLM call per chunk of <=MAX_SESSIONS_PER_BATCH sessions
 * 2. Filters out low-quality (generic/ephemeral) AND sensitive memories (one global call)
 * 3. Deduplicates the newly generated memories against all existing memories (one global call)
 * 4. Returns the final memory objects plus the watermark the caller should advance to
 *
 * `runSessionMemoryPipeline` requires:
 * 1. `conversation`: a Conversation instance, reused across the three LLM calls (each step clears messages before setSystemMessage / addUserMessage)
 * 2. `sessions`: gate-filtered session bundles from `buildSessions`
 * 3. `existingMemoriesList`: existing memory summary strings to deduplicate against
 */

import { renderPrompt, MODEL_FEATURES } from "../Utils.sys.mjs";
import { openAIEngine } from "moz-src:///browser/components/aiwindow/models/openAIEngine.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  loadPrompt:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

import {
  CATEGORIES,
  CATEGORIES_LIST,
  INTENTS,
  INTENTS_LIST,
  MAX_MEMORY_SUMMARY_LENGTH,
  HISTORY,
  CONVERSATION,
  CONVERSATION_USER_REQUEST as USER,
  SESSION,
} from "./MemoriesConstants.sys.mjs";

import {
  INITIAL_MEMORIES_SCHEMA,
  MEMORIES_QUALITY_AND_SENSITIVITY_FILTER_SCHEMA,
  MEMORIES_DEDUPLICATION_SCHEMA,
} from "moz-src:///browser/components/aiwindow/models/memories/MemoriesSchemas.sys.mjs";

// Pipeline input key for unified session bundles.
const SESSIONS = "sessions";

// Max number of session bundles sent to the LLM in a single generation call.
const MAX_SESSIONS_PER_BATCH = 10;

// Max number of retries on transient errors for a single batch before raising the 429 up to the caller.
const MAX_RETRIES_PER_BATCH = 3;

// Number of MS to wait before retrying a transient error
const INITIAL_MEMORY_GENERATION_BATCH_RETRY_DELAY_MS = 12000;

/**
 * Generates, filters, and deduplicates memories from a batch of unified session
 * bundles.
 *
 * Sessions are processed in chunks of at most {@link MAX_SESSIONS_PER_BATCH}:
 * each chunk is one generation call. Candidate memories from every chunk are
 * accumulated, then the expensive quality+sensitivity filter and the dedup pass
 * each run ONCE over the whole pool (cheap rejection first, single global
 * comparison last). Running them globally is what lets dedup catch duplicates
 * that surfaced across different chunks.
 *
 * A chunk that fails on a 429 (rate limit) is retried before aborting the whole pipeline:
 * the error is re-thrown so the caller can back off, nothing is persisted, and the run is
 * retried in full next time. A chunk that fails on any other (deterministic)
 * error loses its candidates and the watermark advances past it, since retrying
 * it would only wedge the pipeline.
 *
 * @param {Conversation} conversation           Conversation reused across the pipeline (cleared between calls)
 * @param {Array<object>} sessions              Session bundles from `buildSessions` (gate-filtered by the caller)
 * @param {Array<string>} existingMemoriesList  Existing memory summary strings to deduplicate against
 * @param {object} [opts]
 * @param {number} [opts.batchSize]             Max sessions per generation call
 * @param {number} [opts.maxBatchRetries]       Max retries per batch per generation call
 * @param {number} [opts.initialMemoryGenerationRetryDelayMS] Number of MS to delay before retrying a transient error
 * @returns {Promise<{memories: Array<object>, processedThroughMs: number}>}
 *   `memories` is the final list of generated, filtered, deduplicated memory
 *   objects. `processedThroughMs` is the max `session_end_ms` the caller should
 *   advance its watermark to: the latest chunk that either succeeded or failed
 *   deterministically.
 * @throws Re-throws a 429 (rate limit) error from any LLM call so the caller can
 *   trigger its back-off.
 */
export async function runSessionMemoryPipeline(
  conversation,
  sessions,
  existingMemoriesList,
  {
    batchSize = MAX_SESSIONS_PER_BATCH,
    maxBatchRetries = MAX_RETRIES_PER_BATCH,
    initialMemoryGenerationRetryDelayMS = INITIAL_MEMORY_GENERATION_BATCH_RETRY_DELAY_MS,
  } = {}
) {
  const candidateMemories = [];
  let processedThroughMs = 0;

  // Step 1: Per-batch generation. Accumulate candidates across all batches.
  for (let i = 0; i < sessions.length; i += batchSize) {
    const batch = sessions.slice(i, i + batchSize);
    const batchMaxEndMs = batch.reduce(
      (max, session) => Math.max(max, session.session_end_ms),
      0
    );

    let batchHandled = false;
    let lastRetryableError;
    for (let attempt = 0; attempt < maxBatchRetries; attempt++) {
      try {
        const batchMemories = await generateInitialMemoriesList(conversation, {
          [SESSIONS]: batch,
        });
        candidateMemories.push(...batchMemories);
        processedThroughMs = Math.max(processedThroughMs, batchMaxEndMs);
        batchHandled = true;
        break;
      } catch (e) {
        if (openAIEngine.isRetryableError(e)) {
          // Transient error: these may be simple rate limiting or budget errors
          // In the event it's just rate limiting, retrying the current batch after 2 minutes to salvage the run
          lastRetryableError = e;
          await new Promise(r =>
            lazy.setTimeout(r, initialMemoryGenerationRetryDelayMS)
          );
          continue;
        }
        // Deterministic failure: retrying won't help, so advance past this batch
        // (its candidates are lost) instead of wedging the pipeline on it.
        processedThroughMs = Math.max(processedThroughMs, batchMaxEndMs);
        console.error(
          "runSessionMemoryPipeline: batch generation failed; skipping past it",
          e
        );
        batchHandled = true;
        break;
      }
    }
    if (!batchHandled) {
      // Retries exhausted on a transient error: propagate so the caller can
      // back off and retry. Watermark is not advanced.
      throw lastRetryableError;
    }
  }

  if (!candidateMemories.length) {
    return { memories: [], processedThroughMs };
  }

  // Step 2: Single global quality+sensitivity filter over the full candidate pool.
  const candidateSummaries = candidateMemories.map(
    memory => memory.memory_summary
  );
  const filteredSummaries = await applyQualityAndSensitivityFilter(
    conversation,
    candidateSummaries
  );
  if (!filteredSummaries || !filteredSummaries.length) {
    return { memories: [], processedThroughMs };
  }

  // Step 3: Single global dedup against the existing store (and across batches).
  const dedupedSummaries = await deduplicateMemories(
    conversation,
    existingMemoriesList,
    filteredSummaries
  );
  if (!dedupedSummaries || !dedupedSummaries.length) {
    return { memories: [], processedThroughMs };
  }

  // Step 4: Map surviving summaries back to full memory objects.
  const memories = await mapFilteredMemoriesToInitialList(
    candidateMemories,
    dedupedSummaries
  );
  return { memories, processedThroughMs };
}

/**
 * Formats a list of strings into a prompt-friendly bullet list
 *
 * @param {List<string>} list
 * @returns {string}
 */
export function formatListForPrompt(list) {
  return list.map(item => `- "${item}"`).join("\n");
}

/**
 * Utility function to cleanly get bullet-formatted category and memory lists
 *
 * @param {string} attributeName  "categories" or "intents"
 * @returns {string}              Formatted list string
 */
export function getFormattedMemoryAttributeList(attributeName) {
  if (attributeName === CATEGORIES) {
    return formatListForPrompt(CATEGORIES_LIST);
  } else if (attributeName === INTENTS) {
    return formatListForPrompt(INTENTS_LIST);
  }
  throw new Error(`Unsupported memory attribute name: ${attributeName}`);
}

/**
 * Extracts a JSON as a map from an LLM response (handles markdown-formatted code blocks)
 *
 * @param {any} response  LLM response
 * @param {any} fallback  Fallback value if parsing fails to protect downstream code
 * @returns {Map}         Parsed JSON object
 */
export function parseAndExtractJSON(response, fallback) {
  const rawContent = response?.finalOutput ?? "";
  const markdownMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const payload = markdownMatch ? markdownMatch[1] : rawContent;
  try {
    return JSON.parse(payload);
  } catch (e) {
    // If we can't parse a JSON from the LLM response, return a tailored fallback value to prevent downstream code failures
    if (e instanceof SyntaxError) {
      console.warn(
        `Could not parse JSON from LLM response; using fallback (${fallback}): ${e.message}`
      );
      return fallback;
    }
    throw new Error(
      `Unexpected error parsing JSON from LLM response: ${e.message}`
    );
  }
}

/**
 * Renders a batch of unified session bundles into prompt text. Each session is
 * a time-window bundle of searches, page titles, and chat messages that
 * occurred together. Source IDs are intentionally NOT rendered: they stay
 * client-side and are never sent to the LLM.
 *
 * @param {Array<object>} sessions  Session bundles produced by `buildSessions`
 * @returns {string}                Prompt-ready text, one block per session
 */
export function renderSessionsForPrompt(sessions) {
  const blocks = [];
  sessions.forEach((session, index) => {
    const lines = [];
    const date = new Date(session.session_start_ms).toISOString().slice(0, 10);
    lines.push(`# Session ${index + 1} (${date})`);

    if (session.search_queries.length) {
      lines.push("## Web Searches");
      for (const query of session.search_queries) {
        lines.push(`- ${query}`);
      }
    }

    if (session.titles.length) {
      lines.push("## Website Titles");
      for (const title of session.titles) {
        lines.push(`- ${title}`);
      }
    }

    if (session.chats.length) {
      const chatLines = [];
      for (const message of session.chats) {
        const content =
          typeof message.content === "string" ? message.content.trim() : "";
        if (content) {
          chatLines.push(`- ${content}`);
        }
      }
      if (chatLines.length) {
        lines.push("## Chat", ...chatLines);
      }
    }

    blocks.push(lines.join("\n"));
  });
  return blocks.join("\n\n").trim();
}

/**
 * Sanitizes a single memory object from LLM output, checking required fields and normalizing score
 *
 * @param {*} memory               Raw memory object from LLM
 * @returns {Map<{
 *  category: string|null,
 *  intent: string|null,
 *  memory_summary: string|null,
 *  score: number,
 * }>|null}                         Sanitized memory or null if invalid
 */
function sanitizeMemory(memory) {
  // Shortcut to return nothing if memory is bad
  if (!memory || typeof memory !== "object") {
    return null;
  }

  // Check for maximum memory summary length
  if (
    memory.memory_summary &&
    memory.memory_summary.length > MAX_MEMORY_SUMMARY_LENGTH
  ) {
    console.warn(
      `Memory rejected: memory_summary exceeds max length of ${MAX_MEMORY_SUMMARY_LENGTH}: "${memory.memory_summary}"`
    );
    return null;
  }

  // Check that the candidate memory object has all the required string fields
  for (const field of ["category", "intent", "memory_summary", "reasoning"]) {
    if (!(field in memory) || typeof memory[field] !== "string") {
      return null;
    }
  }

  // Clamp score to [1,5]; treat missing/invalid as 1
  let score = Number.isFinite(memory.score) ? Math.round(memory.score) : 1;
  if (score < 1) {
    score = 1;
  } else if (score > 5) {
    score = 5;
  }

  const evidence = Array.isArray(memory.evidence) ? memory.evidence : [];

  return {
    category: memory.category,
    intent: memory.intent,
    memory_summary: memory.memory_summary,
    reasoning: memory.reasoning,
    score,
    source: deriveSource(evidence),
    // Retained transiently so `generateInitialMemoriesList` can attribute
    // source IDs; stripped before the memory leaves that function.
    evidence,
  };
}

/**
 * Derives a memory's source tag from the types of its supporting evidence.
 * Evidence types come from the LLM as one of "title" | "search" | "chat" |
 * "user". Browsing + any conversational evidence is cross-modal (SESSION);
 * a direct user query (USER) takes precedence over multi-turn chat.
 *
 * @param {Array<object>} evidence  Evidence items, each with a `type`
 * @returns {string}                One of HISTORY, CONVERSATION, USER, or SESSION
 */
function deriveSource(evidence) {
  if (!Array.isArray(evidence) || !evidence.length) {
    return SESSION;
  }
  const types = new Set(evidence.map(e => e?.type));
  const hasBrowse = types.has("title") || types.has("search");
  const hasUser = types.has("user");
  const hasChat = types.has("chat");
  if (hasBrowse && (hasChat || hasUser)) {
    return SESSION;
  }
  if (hasBrowse) {
    return HISTORY;
  }
  if (hasUser) {
    return USER;
  }
  if (hasChat) {
    return CONVERSATION;
  }
  return SESSION;
}

/**
 * Attributes the real source IDs behind a memory by matching its verbatim
 * evidence strings back to the sessions that produced them. IDs are never sent
 * to the LLM.
 *
 * Attribution is session-level: if any evidence string appears in a session's
 * browse content (titles/queries) or chat content, that session's history /
 * conversation source IDs are credited to the memory.
 *
 * @param {Array<object>} evidence  Evidence items with verbatim `value` strings
 * @param {Array<object>} sessions  The batch's session bundles from `buildSessions`
 * @returns {{history_source_ids: Array<string|number>, conversation_source_ids: Array<string>}}
 */
function attributeSourceIds(evidence, sessions) {
  const historyIds = new Set();
  const conversationIds = new Set();

  for (const item of evidence) {
    const value = typeof item?.value === "string" ? item.value : "";
    if (!value) {
      continue;
    }
    for (const session of sessions) {
      const inBrowse =
        session.search_queries.includes(value) ||
        session.titles.includes(value);
      const inChat = session.chats?.some(
        msg => typeof msg.content === "string" && msg.content.includes(value)
      );
      if (inBrowse) {
        session.history_source_ids.forEach(id => historyIds.add(id));
      }
      if (inChat) {
        session.conversation_source_ids.forEach(id => conversationIds.add(id));
      }
    }
  }

  return {
    history_source_ids: [...historyIds],
    conversation_source_ids: [...conversationIds],
  };
}

/**
 * Normalizes and validates parsed LLM output into a list of memories to handle LLM output variability
 *
 * @param {*} parsed                JSON-parsed LLM output
 * @returns {Array<Map<{
 *  category: string,
 *  intent: string,
 *  memory_summary: string,
 *  score: number,
 * }>>}                             List of sanitized memories
 */
function normalizeMemoryList(parsed) {
  let list = parsed;
  if (!Array.isArray(list)) {
    // If list isn't an array, check that it's an object with a nested "items" array
    if (list && Array.isArray(list.items)) {
      list = list.items;
    } else if (list && typeof list === "object") {
      // If list isn't an array, check that it's a least a single object, so check that list has memory-like keys
      const looksLikeMemory =
        "category" in list || "intent" in list || "memory_summary" in list;
      if (looksLikeMemory) {
        list = [list];
      }
    }
  }
  if (!Array.isArray(list)) {
    return [];
  }

  return list.map(sanitizeMemory).filter(Boolean);
}

/**
 * Prompts an LLM to generate an initial, unfiltered list of candidate memories from user data
 *
 * @param {Conversation} conversation  Conversation reused across the pipeline (cleared between calls)
 * @param {object} sources  User data source type to aggregrated records (i.e., {history: [domainItems, titleItems, searchItems]})
 * @returns {Promise<Array<Map<{
 *  category: string,
 *  intent: string,
 *  memory_summary: string,
 *  score: number,
 * }>>>}                    Promise resolving the list of generated memories
 */
export async function generateInitialMemoriesList(conversation, sources) {
  const [{ prompt: systemPrompt }, { prompt: userPromptTemplate }] =
    await Promise.all([
      lazy.loadPrompt(MODEL_FEATURES.MEMORIES_INITIAL_GENERATION_SYSTEM),
      lazy.loadPrompt(MODEL_FEATURES.MEMORIES_INITIAL_GENERATION_USER),
    ]);

  // Build sources string from the unified session bundles.
  let profileRecordsRenderedStr = "";
  if (sources.hasOwnProperty(SESSIONS)) {
    profileRecordsRenderedStr += renderSessionsForPrompt(sources[SESSIONS]);
  }

  const userPrompt = renderPrompt(userPromptTemplate, {
    categoriesList: getFormattedMemoryAttributeList(CATEGORIES),
    intentsList: getFormattedMemoryAttributeList(INTENTS),
    profileRecordsRenderedStr,
  });

  conversation.clearMessages();
  conversation.setSystemMessage(systemPrompt);
  conversation.addUserMessage(userPrompt);
  const response = await conversation.run({
    responseFormat: { type: "json_schema", schema: INITIAL_MEMORIES_SCHEMA },
    fxAccountToken: await openAIEngine.getFxAccountToken(),
  });

  const parsed = parseAndExtractJSON(response, []);
  const memories = normalizeMemoryList(parsed);

  // Join real source IDs back from the sessions client-side, then drop the
  // transient evidence (never persisted).
  const sessions = sources[SESSIONS] ?? [];
  for (const memory of memories) {
    memory.source_ids = attributeSourceIds(memory.evidence, sessions);
    delete memory.evidence;
  }

  return memories;
}

/**
 * Prompts an LLM to deduplicate new memories against existing ones
 *
 * @param {Conversation} conversation           Conversation reused across the pipeline (cleared between calls)
 * @param {Array<string>} existingMemoriesList  List of existing memory summary strings
 * @param {Array<string>} newMemoriesList       List of new memory summary strings to deduplicate
 * @returns {Promise<Array<string>>}            Promise resolving the final list of deduplicated memory summary strings
 */
export async function deduplicateMemories(
  conversation,
  existingMemoriesList,
  newMemoriesList
) {
  const [{ prompt: systemPrompt }, { prompt: userPromptTemplate }] =
    await Promise.all([
      lazy.loadPrompt(MODEL_FEATURES.MEMORIES_DEDUPLICATION_SYSTEM),
      lazy.loadPrompt(MODEL_FEATURES.MEMORIES_DEDUPLICATION_USER),
    ]);

  const userPrompt = renderPrompt(userPromptTemplate, {
    existingMemoriesList: formatListForPrompt(existingMemoriesList),
    newMemoriesList: formatListForPrompt(newMemoriesList),
  });

  conversation.clearMessages();
  conversation.setSystemMessage(systemPrompt);
  conversation.addUserMessage(userPrompt);
  const response = await conversation.run({
    responseFormat: {
      type: "json_schema",
      schema: MEMORIES_DEDUPLICATION_SCHEMA,
    },
    fxAccountToken: await openAIEngine.getFxAccountToken(),
  });

  const parsed = parseAndExtractJSON(response, { unique_memories: [] });

  if (
    parsed.unique_memories === undefined ||
    !Array.isArray(parsed.unique_memories)
  ) {
    return [];
  }

  // Make sure we filter out any invalid main_memory entries before returning
  return parsed.unique_memories
    .filter(
      item =>
        item.main_memory !== undefined && typeof item.main_memory === "string"
    )
    .map(item => item.main_memory);
}

/**
 * Prompts an LLM to filter out both low-quality (generic/ephemeral) and sensitive
 * memories.
 *
 * @param {Conversation} conversation   Conversation reused across the pipeline (cleared between calls)
 * @param {Array<string>} memoriesList  List of memory summary strings to filter
 * @returns {Promise<Array<string>>}    Promise resolving the list of memory summary strings that are both high quality and non-sensitive
 */
export async function applyQualityAndSensitivityFilter(
  conversation,
  memoriesList
) {
  const { prompt: systemPrompt } = await lazy.loadPrompt(
    MODEL_FEATURES.MEMORIES_QUALITY_AND_SENSITIVITY_FILTER_SYSTEM
  );

  const { prompt: userPromptTemplate } = await lazy.loadPrompt(
    MODEL_FEATURES.MEMORIES_QUALITY_AND_SENSITIVITY_FILTER_USER
  );

  const userPrompt = renderPrompt(userPromptTemplate, {
    memoriesList: formatListForPrompt(memoriesList),
  });

  conversation.clearMessages();
  conversation.setSystemMessage(systemPrompt);
  conversation.addUserMessage(userPrompt);
  const response = await conversation.run({
    responseFormat: {
      type: "json_schema",
      schema: MEMORIES_QUALITY_AND_SENSITIVITY_FILTER_SCHEMA,
    },
    fxAccountToken: await openAIEngine.getFxAccountToken(),
  });

  const parsed = parseAndExtractJSON(response, { kept_memories: [] });

  if (
    parsed.kept_memories === undefined ||
    !Array.isArray(parsed.kept_memories)
  ) {
    return [];
  }

  // Retain input memories and dont let the LLM reword memories
  const inputSet = new Set(memoriesList);
  return parsed.kept_memories.filter(
    item => typeof item === "string" && inputSet.has(item)
  );
}

/**
 *
 * @param {Map<string, any>} initialMemories    List of original, unfiltered memory objects
 * @param {Array<string>} filteredMemoriesList  List of deduplicated and sensitivity-filtered memory summary strings
 * @returns {Promise<Map<string, any>>}         Promise resolving the final list of memory objects
 */
export async function mapFilteredMemoriesToInitialList(
  initialMemories,
  filteredMemoriesList
) {
  return initialMemories.filter(memory =>
    filteredMemoriesList.includes(memory.memory_summary)
  );
}
