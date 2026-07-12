/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MemoryStore, makeMemoryId, migrateMemoryStoreVersionOneToTwo } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/services/MemoryStore.sys.mjs"
  );
const {
  MEMORY_TYPE_SHORT_TERM_MEMORY,
  MEMORY_SENSITIVITY_CATEGORY_NOT_SENSITIVE,
  MEMORY_FRECENCY_MAX_DAYS,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/memories/MemoriesConstants.sys.mjs"
);

add_task(async function test_init_empty_state() {
  // First init should succeed and not throw.
  await MemoryStore.ensureInitialized();

  let memories = await MemoryStore.getMemories();
  equal(memories.length, 0, "New store should start with no memories");

  const meta = await MemoryStore.getMeta();
  equal(
    meta.last_history_memory_ts,
    0,
    "Default last_history_memory_ts should be 0"
  );
  equal(meta.last_chat_memory_ts, 0, "Default last_chat_memory_ts should be 0");
});

add_task(async function test_addMemory() {
  await MemoryStore.ensureInitialized();

  const memory1 = await MemoryStore.addMemory({
    memory_summary: "i love driking coffee",
    reasoning: "searches for nearest coffee places",
    tags: ["category:Food & Drink", "intent:Plan / Organize"],
  });

  equal(
    memory1.memory_summary,
    "i love driking coffee",
    "memory summary should match input"
  );
  Assert.deepEqual(
    memory1.tags,
    ["category:Food & Drink", "intent:Plan / Organize"],
    "Tags should match input"
  );
  equal(
    memory1.reasoning,
    "searches for nearest coffee places",
    "Reasoning should match input"
  );
  await MemoryStore.hardDeleteMemory(memory1.id);
});

add_task(async function test_addMemoryWithoutSource() {
  await MemoryStore.ensureInitialized();

  const memoryBothHistAndChat = await MemoryStore.addMemory({
    memory_summary: "no source",
    reasoning: "no source",
    source_ids: {
      history_source_ids: [1],
      conversation_source_ids: [1],
    },
  });
  Assert.deepEqual(
    memoryBothHistAndChat.sources,
    ["session"],
    "Memory without source but history & conversation IDs should impute session source"
  );
  await MemoryStore.hardDeleteMemory(memoryBothHistAndChat.id);

  const memoryOnlyHist = await MemoryStore.addMemory({
    memory_summary: "no source",
    reasoning: "no source",
    source_ids: {
      history_source_ids: [1],
      conversation_source_ids: [],
    },
  });
  Assert.deepEqual(
    memoryOnlyHist.sources,
    ["history"],
    "Memory without source but history IDs should impute history source"
  );
  await MemoryStore.hardDeleteMemory(memoryOnlyHist.id);

  const memoryOnlyChat = await MemoryStore.addMemory({
    memory_summary: "no source",
    reasoning: "no source",
    source_ids: {
      history_source_ids: [],
      conversation_source_ids: [1],
    },
  });
  Assert.deepEqual(
    memoryOnlyChat.sources,
    ["conversation"],
    "Memory without source but conversation IDs should impute conversation source"
  );
  await MemoryStore.hardDeleteMemory(memoryOnlyChat.id);

  const memoryNoSourceIDs = await MemoryStore.addMemory({
    memory_summary: "no source",
    reasoning: "no source",
    source_ids: {
      history_source_ids: [],
      conversation_source_ids: [],
    },
  });
  Assert.deepEqual(
    memoryNoSourceIDs.sources,
    [],
    "Memory without any source IDs should imput no source"
  );
  await MemoryStore.hardDeleteMemory(memoryNoSourceIDs.id);
});

add_task(async function test_addMemory_and_upsert_by_content() {
  await MemoryStore.ensureInitialized();

  const memory1 = await MemoryStore.addMemory({
    memory_summary: "trip plans to Italy",
    tags: ["category:Travel & Transportation", "intent:Plan / Organize"],
  });

  ok(memory1.id, "Memory should have an id");
  equal(
    memory1.memory_summary,
    "trip plans to Italy",
    "Memory summary should be stored"
  );
  equal(
    memory1.reasoning,
    "",
    "Reasoning should default to empty string when not provided"
  );

  // Add another memory with same (summary, category, intent) – should upsert, not duplicate.
  const memory2 = await MemoryStore.addMemory({
    memory_summary: "trip plans to Italy",
    reasoning: "User searches for Italy travel guides and visits booking sites",
    tags: ["category:Travel & Transportation", "intent:Plan / Organize"],
  });

  equal(
    memory1.id,
    memory2.id,
    "Same summary should produce same deterministic id"
  );
  equal(
    memory2.reasoning,
    "User searches for Italy travel guides and visits booking sites",
    "Second addMemory call for same id should update reasoning"
  );
  Assert.deepEqual(
    memory2.tags,
    ["category:Travel & Transportation", "intent:Plan / Organize"],
    "Should have the expected category and intent tags"
  );

  const memories = await MemoryStore.getMemories();
  equal(memories.length, 1, "Store should still have only one memory");
  await MemoryStore.hardDeleteMemory(memory1.id);
});

add_task(async function test_updateMemory_and_soft_delete() {
  await MemoryStore.ensureInitialized();

  const memory = await MemoryStore.addMemory({
    memory_summary: "debug memory",
    reasoning: "Initial reasoning for debugging",
    tags: ["category:debug", "intent:Monitor / Track"],
    sources: ["history"],
    source_ids: {
      history_source_ids: [1, 2, 3],
      conversation_source_ids: [4, 5, 6],
    },
    keywords: ["one", "two"],
    merge_count: 3,
  });
  const originalCreatedAt = memory.created_at;

  equal(
    memory.reasoning,
    "Initial reasoning for debugging",
    "Initial reasoning should be set"
  );

  const updated = await MemoryStore.updateMemory(memory.id, {
    reasoning: "Updated reasoning after more data",
    sources: ["history", "session"],
    tags: ["category:debug", "something:else"],
    source_ids: {
      history_source_ids: [7, 8],
      conversation_source_ids: [9, 10],
    },
    keywords: ["three"],
    lifetime_accessed_count: 2,
    merge_count: 5,
  });
  equal(
    updated.reasoning,
    "Updated reasoning after more data",
    "updateMemory should update reasoning"
  );

  Assert.equal(
    originalCreatedAt,
    updated.created_at,
    "Updated memory should keep its original creation timestamp"
  );

  const expectedSources = ["history", "session"];
  equal(updated.sources.length, 2, "Updated memory should have 2 sources");
  Assert.ok(
    updated.sources.every(s => expectedSources.includes(s)),
    "Updated memory should have the expected sources"
  );

  const expectedTags = [
    "category:debug",
    "intent:Monitor / Track",
    "something:else",
  ];
  equal(updated.tags.length, 3, "Updated memory should have 3 tags");
  Assert.ok(
    updated.tags.every(t => expectedTags.includes(t)),
    "Updated memory should have the expected tags"
  );

  const expectedHistorySourceIds = [1, 2, 3, 7, 8];
  equal(
    updated.source_ids.history_source_ids.length,
    5,
    "Updated memory should have 5 history source IDs"
  );
  Assert.ok(
    updated.source_ids.history_source_ids.every(i =>
      expectedHistorySourceIds.includes(i)
    ),
    "Updated memory should have the expected history source IDs"
  );

  const expectedConvoSourceIds = [4, 5, 6, 9, 10];
  equal(
    updated.source_ids.conversation_source_ids.length,
    5,
    "Updated memory should have 5 conversation source IDs"
  );
  Assert.ok(
    updated.source_ids.conversation_source_ids.every(i =>
      expectedConvoSourceIds.includes(i)
    ),
    "Updated memory should have the expected conversation source IDs"
  );

  const expectedKeywords = ["one", "two", "three"];
  equal(updated.keywords.length, 3, "Updated memory should have 3 keywords");
  Assert.ok(
    updated.keywords.every(k => expectedKeywords.includes(k)),
    "Updated memory should have the expected keywords"
  );

  Assert.equal(
    updated.lifetime_accessed_count,
    2,
    "Updated memory should have the lifetime_accessed_count from updates"
  );
  Assert.equal(
    updated.merge_count,
    5,
    "Updated memory should have the lifetime_accessed_count from updates"
  );

  const deleted = await MemoryStore.softDeleteMemory(memory.id);

  ok(deleted, "softDeleteMemory should return the updated memory");
  equal(
    deleted.is_deleted,
    true,
    "Soft-deleted memory should have is_deleted = true"
  );

  const nonDeleted = await MemoryStore.getMemories();
  const notFound = nonDeleted.find(i => i.id === memory.id);
  equal(
    notFound,
    undefined,
    "Soft-deleted memory should be filtered out by getMemories()"
  );
});

add_task(async function test_hard_delete() {
  await MemoryStore.ensureInitialized();

  const memory = await MemoryStore.addMemory({
    memory_summary: "to be hard deleted",
    tags: ["category:debug", "intent: Monitor / Track"],
  });

  let memories = await MemoryStore.getMemories();
  const beforeCount = memories.length;

  const removed = await MemoryStore.hardDeleteMemory(memory.id);
  equal(
    removed,
    true,
    "hardDeleteMemory should return true when removing existing memory"
  );

  memories = await MemoryStore.getMemories();
  const afterCount = memories.length;

  equal(
    beforeCount - 1,
    afterCount,
    "hardDeleteMemory should physically remove entry from array"
  );
});

add_task(async function test_updateMeta_and_persistence_roundtrip() {
  await MemoryStore.ensureInitialized();

  const now = Date.now();

  await MemoryStore.updateMeta({
    last_history_memory_ts: now,
  });

  let meta = await MemoryStore.getMeta();
  equal(
    meta.last_history_memory_ts,
    now,
    "updateMeta should update last_history_memory_ts"
  );
  equal(
    meta.last_chat_memory_ts,
    0,
    "updateMeta should not touch last_chat_memory_ts when not provided"
  );

  const chatTime = now + 1000;
  await MemoryStore.updateMeta({
    last_chat_memory_ts: chatTime,
  });

  meta = await MemoryStore.getMeta();
  equal(
    meta.last_history_memory_ts,
    now,
    "last_history_memory_ts should remain unchanged when only chat ts updated"
  );
  equal(
    meta.last_chat_memory_ts,
    chatTime,
    "last_chat_memory_ts should be updated"
  );

  // Force a write to disk.
  await MemoryStore.testOnlyFlush();

  // Simulate a fresh import by reloading module.
  // This uses the xpcshell helper to bypass module caching.
  const { MemoryStore: FreshStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/services/MemoryStore.sys.mjs",
    { ignoreCache: true }
  );

  await FreshStore.ensureInitialized();

  const meta2 = await FreshStore.getMeta();
  equal(
    meta2.last_history_memory_ts,
    now,
    "last_history_memory_ts should survive roundtrip to disk"
  );
  equal(
    meta2.last_chat_memory_ts,
    chatTime,
    "last_chat_memory_ts should survive roundtrip to disk"
  );

  const memories = await FreshStore.getMemories();
  ok(Array.isArray(memories), "Memories should be an array after reload");
});

add_task(async function test_reasoning_field_persistence() {
  await MemoryStore.ensureInitialized();

  const testReasoning =
    "User frequently searches for coffee shops and visits coffee-related websites";

  const memory = await MemoryStore.addMemory({
    memory_summary: "Loves specialty coffee",
    tags: ["category: Food & Drink", "intent: Buy / Acquire"],
    reasoning: testReasoning,
  });

  equal(
    memory.reasoning,
    testReasoning,
    "Reasoning should be stored when creating new memory"
  );

  const updatedReasoning =
    "User searches for and visits multiple specialty coffee roasters";
  const updated = await MemoryStore.updateMemory(memory.id, {
    reasoning: updatedReasoning,
  });

  equal(
    updated.reasoning,
    updatedReasoning,
    "Reasoning should be updatable via updateMemory"
  );

  await MemoryStore.testOnlyFlush();

  const { MemoryStore: FreshStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/services/MemoryStore.sys.mjs",
    { ignoreCache: true }
  );

  await FreshStore.ensureInitialized();
  const persistedMemories = await FreshStore.getMemories();
  const persistedMemory = persistedMemories.find(m => m.id === memory.id);

  ok(persistedMemory, "Memory should exist after reload");
  equal(
    persistedMemory.reasoning,
    updatedReasoning,
    "Reasoning should survive persistence roundtrip"
  );

  await FreshStore.hardDeleteMemory(memory.id);
});

add_task(async function test_getMemories_filters_by_memoryIds_set() {
  await MemoryStore.ensureInitialized();

  const mem1 = await MemoryStore.addMemory({
    memory_summary: "likes coffee",
    tags: ["category: Food & Drink", "intent: Plan / Organize"],
  });
  const mem2 = await MemoryStore.addMemory({
    memory_summary: "likes tea",
    tags: ["category: Food & Drink", "intent: Communicate / Share"],
  });
  const mem3 = await MemoryStore.addMemory({
    memory_summary: "likes playing tennis",
    tags: ["category: Sports & Fitness", "intent: Plan / Organize"],
  });

  const result = await MemoryStore.getMemories({
    memoryIds: new Set([mem1.id, mem3.id]),
  });

  Assert.equal(result.length, 2, "Should return only the 2 requested memories");
  Assert.ok(
    result.some(m => m.id === mem1.id),
    "Result should include mem1"
  );
  Assert.ok(
    result.some(m => m.id === mem3.id),
    "Result should include mem3"
  );
  Assert.ok(
    !result.some(m => m.id === mem2.id),
    "Result should not include mem2"
  );

  await MemoryStore.hardDeleteMemory(mem1.id);
  await MemoryStore.hardDeleteMemory(mem2.id);
  await MemoryStore.hardDeleteMemory(mem3.id);
});

add_task(async function test_create_memory_id() {
  const memoryPartial = {
    memory_summary: "Likes coffee",
    tags: ["category:Food & Drink", "intent:Communicate / Share"],
  };
  const memoryId = makeMemoryId(memoryPartial);
  Assert.equal(
    memoryId.split(".")[0],
    "mem",
    "Memory ID should start with the correct prefix"
  );
});

add_task(async function test_migrate_memories_from_v1_to_v2() {
  const memoriesV1 = [
    {
      id: "mem.123",
      memory_summary: "Likes dogs",
      reasoning: "User researches dog facts, treats, and training advice",
      category: "Dogs",
      intent: "Share / Communicate",
      score: 1.0,
      source: "history",
      source_ids: {
        history_source_ids: [1, 2, 3],
        conversation_source_ids: [4, 5, 6],
      },
      is_deleted: false,
      updated_at: Date.now(),
    },
  ];

  const memoriesV2 = migrateMemoryStoreVersionOneToTwo(memoriesV1);

  // Check that 1 memory comes out
  Assert.ok(
    Array.isArray(memoriesV2),
    "Migrated memories should be in an array"
  );
  Assert.equal(
    memoriesV2.length,
    1,
    "Migrated memories array should have only 1 entry"
  );

  const memoryV2 = memoriesV2[0];
  // Check fields that should have been deleted
  for (const prop of ["score", "source", "category", "intent"]) {
    Assert.ok(
      !memoryV2.hasOwnProperty(prop),
      `"${prop}" should be deleted from the migrated memory`
    );
  }

  // Check system fields
  Assert.equal(
    memoryV2.id,
    "mem.123",
    "Migrated memory should have its original ID"
  );
  Assert.equal(
    memoryV2.type,
    MEMORY_TYPE_SHORT_TERM_MEMORY,
    `Migrated memory type should be "${MEMORY_TYPE_SHORT_TERM_MEMORY}"`
  );
  Assert.deepEqual(
    memoryV2.sources,
    ["history"],
    'Migrated memory sources should have 1 entry: "history"'
  );
  Assert.deepEqual(
    memoryV2.source_ids,
    { history_source_ids: [1, 2, 3], conversation_source_ids: [4, 5, 6] },
    "Migrated memory should have its original source IDs"
  );
  Assert.equal(
    memoryV2.sensitivity_category,
    MEMORY_SENSITIVITY_CATEGORY_NOT_SENSITIVE,
    `Migrated memory sensitivity category should be "${MEMORY_SENSITIVITY_CATEGORY_NOT_SENSITIVE}\"`
  );
  Assert.equal(
    memoryV2.is_deleted,
    false,
    "Migrated memory should not be soft deleted"
  );

  // Check descriptive fields
  Assert.equal(
    memoryV2.memory_summary,
    "Likes dogs",
    "Migrated memory should have its original summary"
  );
  Assert.equal(
    memoryV2.reasoning,
    "User researches dog facts, treats, and training advice",
    "Migrated memory should have its original reasoning"
  );
  Assert.deepEqual(
    memoryV2.tags,
    ["category:Dogs", "intent:Share / Communicate"],
    "Migrated memory tags should include its original category and intent"
  );
  Assert.deepEqual(
    memoryV2.keywords,
    [],
    "Migrated memory without entities in v1 should have an empty array in v2"
  );
  Assert.deepEqual(
    memoryV2.component_summaries,
    [],
    "Migrated memory should have an empty component_summaries array"
  );

  // Check tracker fields
  Assert.ok(
    Number.isFinite(memoryV2.created_at),
    "Migrated memory creation timestamp should be a number"
  );
  Assert.ok(
    Number.isFinite(memoryV2.updated_at),
    "Migrated memory update timestamp should be a number"
  );
  Assert.equal(
    memoryV2.created_at,
    memoryV2.updated_at,
    "Migrated memory creation and update timestamps should be the same"
  );
  Assert.equal(
    memoryV2.last_accessed,
    null,
    "Migrated memory last accessed timestamp should be null (never used)"
  );
  Assert.deepEqual(
    memoryV2.recent_accessed_counts,
    Object.fromEntries(
      Array.from({ length: MEMORY_FRECENCY_MAX_DAYS }, (_, i) => [i, 0])
    ),
    "Migrated memory recent accessed counts object should have the expected base structure"
  );
  Assert.equal(
    memoryV2.lifetime_accessed_count,
    0,
    "Migrated memory lifetime accessed count should be 0 (never used)"
  );
  Assert.equal(
    memoryV2.frecency,
    0,
    "Migrated memory frecency should be 0 (never used)"
  );
  Assert.equal(
    memoryV2.merge_count,
    0,
    "Migrated memory merge count should be 0 (never used)"
  );
});
