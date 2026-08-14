/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  generateConversationStartersSidebar,
  getMemoriesForResumeActivityConversationStarter,
  generateResumeActivityConversationStarters,
  constructConversationToResumeActivity,
  _clearResumeActivityCacheForTesting,
  _setBuildConversationForTesting,
  MAX_NUM_URLS_PER_MEMORY,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/ConversationSuggestions.sys.mjs"
);
const { buildConversation, loadPrompt } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs"
);
const { MemoryStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/services/MemoryStore.sys.mjs"
);
const {
  HISTORY,
  CONVERSATION,
  SESSION,
  MEMORY_SENSITIVITY_CATEGORY_NOT_SENSITIVE,
  MEMORY_SENSITIVITY_CATEGORY_SENSITIVE,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/memories/MemoriesConstants.sys.mjs"
);
const { ChatStore, ChatConversation, ChatMessage, MESSAGE_ROLE } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/ui/modules/ChatStore.sys.mjs"
  );
const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);
const { MemoriesManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/memories/MemoriesManager.sys.mjs"
);
const { PURPOSES, MODEL_FEATURES } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs"
);
const { MESSAGE_LENGTH_THRESHOLD } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/memories/MemoriesChatSource.sys.mjs"
);

const RESUME_ACTIVITY_TEST_TIME = Date.UTC(2026, 0, 1);

function makePage(title, overrides = {}) {
  return {
    url: `https://example.com/${title.toLowerCase().replaceAll(" ", "-")}`,
    title,
    ...overrides,
  };
}

function makeChat(title, overrides = {}) {
  return {
    id: title.toLowerCase().replaceAll(" ", "-"),
    title,
    updatedDate: RESUME_ACTIVITY_TEST_TIME,
    messages: [
      { role: MESSAGE_ROLE.USER, body: `${title} user` },
      { role: MESSAGE_ROLE.ASSISTANT, body: `${title} assistant` },
    ],
    ...overrides,
  };
}

function makeMemory(summary, overrides = {}) {
  return {
    memory_summary: summary,
    sensitivity_category: MEMORY_SENSITIVITY_CATEGORY_NOT_SENSITIVE,
    sources: [HISTORY],
    frecency: 1,
    updated_at: RESUME_ACTIVITY_TEST_TIME,
    pages: [makePage(summary)],
    ...overrides,
  };
}

add_task(async function test_convo_starter_generation_with_mock_server() {
  const { server, port } = startMockOpenAI({
    streamChunks: ["suggestion 1\nsuggestion 2"],
  });
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.endpoint", `http://localhost:${port}/v1`]],
  });

  try {
    const tabs = [
      {
        url: "https://example.com",
        title: "Example Domain",
      },
    ];
    const generated = await generateConversationStartersSidebar(tabs, 2, true);
    Assert.deepEqual(
      generated,
      [
        { text: "suggestion 1", type: "chat" },
        { text: "suggestion 2", type: "chat" },
      ],
      "Should return two suggestions"
    );
  } finally {
    await SpecialPowers.popPrefEnv();
    await stopMockOpenAI(server);
  }
});

add_setup(async function setupResumeActivityConversationStarterTests() {
  const originalLastSessionMemoryTimestamp =
    await MemoriesManager.getLastSessionMemoryTimestamp();

  await SpecialPowers.pushPrefEnv({
    set: [
      ["places.history.enabled", true],
      ["browser.privatebrowsing.autostart", false],
    ],
  });

  registerCleanupFunction(async () => {
    _clearResumeActivityCacheForTesting();
    try {
      await PlacesUtils.history.clear();
    } finally {
      try {
        await MemoriesManager.setLastSessionMemoryTimestamp(
          originalLastSessionMemoryTimestamp
        );
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    }
  });
});

/**
 * Rewrites moz_places.url_hash for pages carrying a `urlHash` override, since
 * Places always computes the hash from the URL on insert.
 *
 * @param {Array<object>} pages - Pages from makePage
 */
async function applyUrlHashOverrides(pages) {
  const overridden = pages.filter(page => page.urlHash !== undefined);
  if (!overridden.length) {
    return;
  }
  await PlacesUtils.withConnectionWrapper(
    "test-resume-activity-override-url-hash",
    async db => {
      for (const { url, urlHash } of overridden) {
        await db.execute(
          `UPDATE moz_places
           SET url_hash = :urlHash
           WHERE url = :url`,
          { url, urlHash }
        );
      }
    }
  );
}

async function addResumeActivityTestMemories(memories) {
  const pages = memories.flatMap(memory => memory.pages).filter(Boolean);
  if (pages.length) {
    await PlacesUtils.history.insertMany(
      pages.map((page, index) => ({
        ...page,
        visits: [
          {
            date: new Date(
              page.lastVisitDate ?? RESUME_ACTIVITY_TEST_TIME - index * 60_000
            ),
            transition: PlacesUtils.history.TRANSITIONS.LINK,
          },
        ],
      }))
    );
    await applyUrlHashOverrides(pages);
  }

  const addedMemories = [];
  const overallAddedConversationIds = [];
  try {
    for (const { pages: memoryPages, chats, ...memory } of memories) {
      const conversationIdsPerMemory = [];
      for (const chat of chats ?? []) {
        const conversation = new ChatConversation({
          id: chat.id ?? crypto.randomUUID(),
          title: chat.title,
          updatedDate: chat.updatedDate,
          messages: chat.messages.map(
            (message, ordinal) =>
              new ChatMessage({
                ordinal,
                role: message.role,
                content: { type: "text", body: message.body },
              })
          ),
        });
        await ChatStore.updateConversation(conversation);
        conversationIdsPerMemory.push(conversation.id);
        overallAddedConversationIds.push(conversation.id);
      }
      addedMemories.push(
        await MemoryStore.addMemory({
          ...memory,
          source_ids: {
            history_source_ids: memoryPages?.map(
              ({ url, urlHash }) => urlHash ?? PlacesUtils.history.hashURL(url)
            ),
            conversation_source_ids: conversationIdsPerMemory,
          },
        })
      );
    }
  } catch (error) {
    for (const memory of addedMemories) {
      await MemoryStore.hardDeleteMemory(memory.id);
    }
    for (const conversationId of overallAddedConversationIds) {
      await ChatStore.deleteConversationById(conversationId);
    }
    throw error;
  }

  return addedMemories;
}

async function cleanupResumeActivityTestMemories(addedMemories) {
  try {
    for (const memory of addedMemories) {
      for (const conversationId of memory.source_ids?.conversation_source_ids ??
        []) {
        await ChatStore.deleteConversationById(conversationId);
      }
      await MemoryStore.hardDeleteMemory(memory.id);
    }
  } finally {
    _clearResumeActivityCacheForTesting();
    // Undo any url_hash overrides so history.clear() sees a consistent table.
    await PlacesUtils.withConnectionWrapper(
      "test-resume-activity-restore-url-hash",
      db =>
        db.execute(
          `UPDATE moz_places
           SET url_hash = hash(url)
           WHERE url_hash <> hash(url)`
        )
    );
    await PlacesUtils.history.clear();
  }
}

add_task(async function test_getMemoriesForResumeActivityConversationStarter() {
  const cases = [
    {
      name: "Sensitive memories are excluded",
      memories: [
        makeMemory("Public"),
        makeMemory("Sensitive", {
          sensitivity_category: MEMORY_SENSITIVITY_CATEGORY_SENSITIVE,
        }),
      ],
      expected: ["Public"],
    },
    {
      name: "Frecency wins, then updated_at",
      memories: [
        makeMemory("Older tie", {
          frecency: 5,
          updated_at: RESUME_ACTIVITY_TEST_TIME - 60 * 60_000,
        }),
        makeMemory("Newer tie", {
          frecency: 5,
          updated_at: RESUME_ACTIVITY_TEST_TIME - 30 * 60_000,
        }),
        makeMemory("Higher frecency", {
          frecency: 10,
          updated_at: RESUME_ACTIVITY_TEST_TIME - 2 * 60 * 60_000,
        }),
      ],
      expected: ["Higher frecency", "Newer tie", "Older tie"],
    },
    {
      name: "Conversation-only memories are excluded",
      memories: [
        makeMemory("History"),
        makeMemory("Conversation", {
          sources: [CONVERSATION],
          pages: [],
          chats: [makeChat("Conversation chat")],
        }),
      ],
      expected: ["History"],
    },
    {
      name: "SESSION and HISTORY memories with history lineage are included",
      memories: [
        makeMemory("History", { sources: [HISTORY], frecency: 1 }),
        makeMemory("Session", { sources: [SESSION], frecency: 2 }),
      ],
      expected: ["Session", "History"],
    },
    {
      name: "A legacy HISTORY memory without history IDs is excluded",
      memories: [makeMemory("Current"), makeMemory("Legacy", { pages: [] })],
      expected: ["Current"],
    },
    {
      name: "count truncates the sorted result",
      memories: [
        makeMemory("First", { frecency: 3 }),
        makeMemory("Second", { frecency: 2 }),
        makeMemory("Third", { frecency: 1 }),
      ],
      count: 2,
      expected: ["First", "Second"],
    },
  ];

  for (const { name, memories, count = memories.length, expected } of cases) {
    let addedMemories = [];
    try {
      addedMemories = await addResumeActivityTestMemories(memories);
      const retrievedMemories =
        await getMemoriesForResumeActivityConversationStarter(count);
      Assert.deepEqual(
        retrievedMemories.map(memory => memory.memory_summary),
        expected,
        name
      );
    } finally {
      await cleanupResumeActivityTestMemories(addedMemories);
    }
  }
});

add_task(async function test_generateResumeActivityConversationStarters() {
  // Page A4 and its twin share a url_hash, so neither should resolve to a URL.
  const collidingUrl = "https://example.com/a4";
  const testMemories = [
    makeMemory("Memory A", {
      reasoning: "Reason A",
      frecency: 10,
      pages: [
        makePage("Page A4 hash twin", {
          url: `${collidingUrl}-hash-twin`,
          urlHash: PlacesUtils.history.hashURL(collidingUrl),
          lastVisitDate: RESUME_ACTIVITY_TEST_TIME + 2 * 60_000,
        }),
        makePage("Page A4", {
          url: collidingUrl,
          lastVisitDate: RESUME_ACTIVITY_TEST_TIME + 60_000,
        }),
        makePage("Page A3", {
          url: "https://example.com/a3",
          lastVisitDate: RESUME_ACTIVITY_TEST_TIME,
        }),
        makePage('Page "A2"', {
          url: "https://example.com/a2",
          lastVisitDate: RESUME_ACTIVITY_TEST_TIME - 1 * 60_000,
        }),
        makePage("Page A1", {
          url: "https://example.com/a1",
          lastVisitDate: RESUME_ACTIVITY_TEST_TIME - 2 * 60_000,
        }),
      ],
    }),
    makeMemory("Memory B", {
      reasoning: "Reason B",
      sources: [HISTORY, CONVERSATION],
      frecency: 8,
      pages: [
        makePage("Page B2", { url: "https://example.com/b2" }),
        makePage("Page B1", { url: "https://example.com/b1" }),
      ],
      chats: [
        makeChat("Chat B1 older", {
          id: "chat1",
          updatedDate: RESUME_ACTIVITY_TEST_TIME - 1000 * 60 * 45,
        }),
        makeChat("Chat B2 newer", {
          id: "chat2",
          updatedDate: RESUME_ACTIVITY_TEST_TIME - 1000 * 60 * 20,
          messages: [
            {
              role: MESSAGE_ROLE.SYSTEM,
              body: "B2 system dropped",
            },
            {
              role: MESSAGE_ROLE.USER,
              body: "B2 oldest dropped",
            },
            {
              role: MESSAGE_ROLE.ASSISTANT,
              body: "B2 keep 1",
            },
            {
              role: MESSAGE_ROLE.TOOL,
              body: "B2 tool dropped",
            },
            {
              role: MESSAGE_ROLE.USER,
              body: "B2 keep 2",
            },
            {
              role: MESSAGE_ROLE.ASSISTANT,
              body: "B2 keep 3",
            },
          ],
        }),
      ],
    }),
  ];

  let addedMemories = [];
  try {
    addedMemories = await addResumeActivityTestMemories(testMemories);
    const memoriesForResumeActivity =
      await getMemoriesForResumeActivityConversationStarter(2);
    Assert.equal(
      memoriesForResumeActivity.length,
      2,
      "The Resume Activity selector should return both synthetic memories"
    );

    const mockEngineManager = new MockEngineManager();

    let generationConversation = null;
    _setBuildConversationForTesting(async (feature, opts) => {
      generationConversation = await buildConversation(feature, opts);
      return generationConversation;
    });

    try {
      const suggestionsPromise = generateResumeActivityConversationStarters();
      const { request, respond } = await mockEngineManager.captureRequest({
        purpose: PURPOSES.CHAT,
      });
      Assert.deepEqual(
        request.args.map(message => message.role),
        ["system", "user"],
        "The request should contain system and user messages"
      );
      const userPrompt = request.args[1].content;
      for (const expectedContent of [
        "memory_summary: Memory A",
        "reasoning: Reason A",
        '  - "Page A1" (Untrusted webpage data)',
        '  - "Page \\"A2\\"" (Untrusted webpage data)',
        '  - "Page A3" (Untrusted webpage data)',
        "memory_summary: Memory B",
        "reasoning: Reason B",
        "B2 keep 1",
        "B2 keep 2",
        "B2 keep 3",
      ]) {
        Assert.ok(
          userPrompt.includes(expectedContent),
          `The prompt should include: ${expectedContent}`
        );
      }
      for (const excludedContent of [
        "B2 system dropped",
        "B2 tool dropped",
        "B2 oldest dropped",
        "Page A4",
      ]) {
        Assert.ok(
          !userPrompt.includes(excludedContent),
          `The prompt should exclude: ${excludedContent}`
        );
      }
      const pageA1Index = userPrompt.indexOf(
        '  - "Page A1" (Untrusted webpage data)'
      );
      const pageA2Index = userPrompt.indexOf(
        '  - "Page \\"A2\\"" (Untrusted webpage data)'
      );
      const pageA3Index = userPrompt.indexOf(
        '  - "Page A3" (Untrusted webpage data)'
      );
      Assert.ok(
        pageA1Index < pageA2Index && pageA2Index < pageA3Index,
        "The prompt should order pages from oldest to newest"
      );

      const newerChatIndex = userPrompt.indexOf("Chat B2 newer");
      const olderChatIndex = userPrompt.indexOf("Chat B1 older");
      Assert.ok(
        newerChatIndex > -1 && olderChatIndex > -1,
        "The prompt should include both newer and older chat"
      );
      Assert.less(
        olderChatIndex,
        newerChatIndex,
        "The prompt should order chats from oldest to newest"
      );
      respond(
        JSON.stringify([
          {
            id: 1,
            headline: "Headline B!",
            status: "Status B;",
          },
          {
            id: 0,
            headline: "Headline A.",
            status: "Status A:",
          },
          {
            id: 2,
            headline: "hallucinated element",
            status: "hallucinated status",
          },
        ])
      );
      const suggestions = await suggestionsPromise;
      Assert.deepEqual(
        suggestions.map(({ memory, content }) => ({
          memorySummary: memory.memory_summary,
          content,
        })),
        [
          {
            memorySummary: "Memory A",
            content: {
              headline: "Headline A",
              status: "Status A",
              previewTabs: [
                {
                  url: "https://example.com/a1",
                  title: "Page A1",
                },
                {
                  url: "https://example.com/a2",
                  title: 'Page "A2"',
                },
                {
                  url: "https://example.com/a3",
                  title: "Page A3",
                },
              ],
            },
          },
          {
            memorySummary: "Memory B",
            content: {
              headline: "Headline B",
              status: "Status B",
              previewTabs: [
                {
                  url: "https://example.com/b1",
                  title: "Page B1",
                },
                {
                  url: "https://example.com/b2",
                  title: "Page B2",
                },
              ],
            },
          },
        ],
        "The generator should map cards by id and return exact suggestion content, without punctuation in the headline and status, with the correctly ordered preview tabs, without hallucinated elements, and without pages whose url_hash collides"
      );

      Assert.ok(
        !("tools" in request),
        "The request should not offer any tools to the model"
      );
      Assert.ok(
        !("tool_choice" in request),
        "The request should not set tool_choice"
      );
      Assert.equal(
        generationConversation.securityProperties.privateData,
        true,
        "privateData should be set: the prompt carries memories and browsing history"
      );
      Assert.equal(
        generationConversation.securityProperties.untrustedInput,
        true,
        "untrustedInput should be set: the prompt carries webpage titles"
      );
      Assert.deepEqual(
        [...generationConversation.seenUrls],
        [],
        "The generation conversation should not track any URLs"
      );
    } finally {
      _setBuildConversationForTesting(null);
      mockEngineManager.cleanupMocks();
    }
  } finally {
    await cleanupResumeActivityTestMemories(addedMemories);
  }
});

add_task(
  async function test_generateResumeActivityConversationStarters_longInputs() {
    const testMemories = [
      makeMemory("Memory A", {
        reasoning: "Reason A",
        frecency: 10,
        pages: Array.from({ length: MAX_NUM_URLS_PER_MEMORY }, (_, i) =>
          makePage(`Page A${i}`, {
            url: `https://example.com/a${i}`,
            lastVisitDate: RESUME_ACTIVITY_TEST_TIME,
          })
        ),
        chats: [
          makeChat("Chat A1", {
            id: "chat1",
            messages: [
              {
                role: MESSAGE_ROLE.USER,
                body: "A".repeat(MESSAGE_LENGTH_THRESHOLD + 1),
              },
            ],
          }),
        ],
      }),
    ];

    let addedMemories = [];
    try {
      addedMemories = await addResumeActivityTestMemories(testMemories);
      const mockEngineManager = new MockEngineManager();

      try {
        const suggestionsPromise = generateResumeActivityConversationStarters();
        const { request, respond } = await mockEngineManager.captureRequest({
          purpose: PURPOSES.CHAT,
        });
        Assert.ok(
          request.args[1].content.includes("Page A0"),
          "The prompt should include the zeroth page"
        );
        Assert.ok(
          !request.args[1].content.includes(`Page A${MAX_NUM_URLS_PER_MEMORY}`),
          `The prompt should exclude: Page A${MAX_NUM_URLS_PER_MEMORY}`
        );
        Assert.equal(
          request.args[1].content.indexOf(
            "A".repeat(MESSAGE_LENGTH_THRESHOLD + 1)
          ),
          -1,
          "The prompt should exclude the full chat message that exceeds the threshold"
        );
        Assert.greater(
          request.args[1].content.indexOf("A".repeat(MESSAGE_LENGTH_THRESHOLD)),
          0,
          `The prompt should include the first ${MESSAGE_LENGTH_THRESHOLD} characters of the chat message`
        );

        respond(
          JSON.stringify([
            {
              id: 0,
              headline: "Headline A",
              status: "Status A",
            },
          ])
        );
        const suggestions = await suggestionsPromise;
        Assert.deepEqual(
          suggestions.map(({ memory, content }) => ({
            memorySummary: memory.memory_summary,
            content,
          })),
          [
            {
              memorySummary: "Memory A",
              content: {
                headline: "Headline A",
                status: "Status A",
                previewTabs: Array.from(
                  { length: MAX_NUM_URLS_PER_MEMORY },
                  (_, i) => ({
                    url: `https://example.com/a${i}`,
                    title: `Page A${i}`,
                  })
                ),
              },
            },
          ],
          "The generator should return the correct suggestion content with truncated preview tabs"
        );
      } finally {
        mockEngineManager.cleanupMocks();
      }
    } finally {
      await cleanupResumeActivityTestMemories(addedMemories);
    }
  }
);

add_task(
  async function test_generateResumeActivityConversationStarters_cache() {
    const testMemories = [
      makeMemory("Cache memory", {
        reasoning: "Cache reason",
        frecency: 10,
        pages: [makePage("Cache page", { url: "https://example.com/cache" })],
      }),
    ];
    let addedMemories = [];

    try {
      addedMemories = await addResumeActivityTestMemories(testMemories);
      await MemoriesManager.setLastSessionMemoryTimestamp(
        RESUME_ACTIVITY_TEST_TIME
      );

      const mockEngineManager = new MockEngineManager();

      try {
        const firstResultPromise = generateResumeActivityConversationStarters();
        const concurrentResultPromise =
          generateResumeActivityConversationStarters();
        const { respond } = await mockEngineManager.captureRequest({
          purpose: PURPOSES.CHAT,
        });
        const engine = mockEngineManager.engines.get(PURPOSES.CHAT);
        Assert.equal(
          engine.runRequests.size,
          1,
          "Concurrent calls should share one inference request"
        );
        respond(
          JSON.stringify([{ id: 0, headline: "First.", status: "One." }])
        );
        const [firstResult, concurrentResult] = await Promise.all([
          firstResultPromise,
          concurrentResultPromise,
        ]);
        Assert.equal(
          firstResult[0].content.headline,
          "First",
          "The initial call should return the first inference result"
        );
        Assert.strictEqual(
          concurrentResult,
          firstResult,
          "Concurrent callers should receive the same result"
        );

        const secondResult = await generateResumeActivityConversationStarters();
        Assert.strictEqual(
          secondResult,
          firstResult,
          "Matching inputs should return the cached result"
        );
        Assert.equal(
          engine.runRequests.size,
          0,
          "A cache hit should not run inference"
        );

        // A new watermark should trigger a new inference request and return a new result.
        await MemoriesManager.setLastSessionMemoryTimestamp(
          RESUME_ACTIVITY_TEST_TIME + 1
        );
        const newWatermarkResult = generateResumeActivityConversationStarters();
        const { request: newWatermarkRequest, respond: newWatermarkRespond } =
          await mockEngineManager.captureRequest({
            purpose: PURPOSES.CHAT,
          });
        newWatermarkRespond(
          JSON.stringify([{ id: 0, headline: "Second", status: "Two." }])
        );
        Assert.ok(
          newWatermarkRequest,
          "A new watermark should trigger a new inference request"
        );
        Assert.equal(
          (await newWatermarkResult)[0].content.headline,
          "Second",
          "A new watermark should return a new inference result"
        );

        // A failed request should return an empty array and cache that result.
        await MemoriesManager.setLastSessionMemoryTimestamp(
          RESUME_ACTIVITY_TEST_TIME
        );
        const failedRequestPromise =
          generateResumeActivityConversationStarters();
        const { respond: failedRespond } =
          await mockEngineManager.captureRequest({
            purpose: PURPOSES.CHAT,
          });
        failedRespond([]);
        const failedResult = await failedRequestPromise;
        Assert.deepEqual(
          failedResult,
          [],
          "A failed request should return an empty array"
        );

        const cachedFailedResult =
          await generateResumeActivityConversationStarters();
        Assert.strictEqual(
          cachedFailedResult,
          failedResult,
          "A cached failed result should return the same empty array"
        );
      } finally {
        mockEngineManager.cleanupMocks();
      }
    } finally {
      await cleanupResumeActivityTestMemories(addedMemories);
    }
  }
);

add_task(async function test_resumeActivity_cacheExcludesDeletedMemories() {
  const testMemories = [
    makeMemory("Deleted cache memory", { frecency: 11 }),
    makeMemory("Current cache memory", { frecency: 10 }),
  ];
  let addedMemories = [];

  try {
    addedMemories = await addResumeActivityTestMemories(testMemories);
    await MemoriesManager.setLastSessionMemoryTimestamp(
      RESUME_ACTIVITY_TEST_TIME + 5
    );
    const mockEngineManager = new MockEngineManager();
    let runSpy;

    try {
      const firstResultPromise = generateResumeActivityConversationStarters();
      await mockEngineManager.respondTo({
        purpose: PURPOSES.CHAT,
        response: JSON.stringify([
          { id: 0, headline: "Deleted", status: "Cached" },
          { id: 1, headline: "Current", status: "Cached" },
        ]),
      });
      const firstResult = await firstResultPromise;
      Assert.deepEqual(
        firstResult.map(({ memory }) => memory.id),
        addedMemories.map(memory => memory.id),
        "The initial result should contain both memories"
      );

      await MemoriesManager.softDeleteMemoryById(addedMemories[0].id);
      const engine = mockEngineManager.engines.get(PURPOSES.CHAT);
      runSpy = sinon.spy(engine, "run");

      const cachedResult = await generateResumeActivityConversationStarters();
      Assert.deepEqual(
        cachedResult.map(({ memory }) => memory.id),
        [addedMemories[1].id],
        "The cached result should exclude soft-deleted memories"
      );
      Assert.equal(runSpy.callCount, 0, "Filtering should reuse the cache");
    } finally {
      runSpy?.restore();
      mockEngineManager.cleanupMocks();
    }
  } finally {
    await cleanupResumeActivityTestMemories(addedMemories);
  }
});

add_task(async function test_resumeActivity_emptyResultIsCached() {
  let addedMemories = [];
  let getMemoriesSpy;

  try {
    addedMemories = await addResumeActivityTestMemories([]);
    await MemoriesManager.setLastSessionMemoryTimestamp(
      RESUME_ACTIVITY_TEST_TIME + 10
    );
    getMemoriesSpy = sinon.spy(MemoriesManager, "getMemoriesByAttribute");

    const firstResult = await generateResumeActivityConversationStarters();
    const secondResult = await generateResumeActivityConversationStarters();

    Assert.deepEqual(firstResult, [], "No memories should produce no cards");
    Assert.strictEqual(
      secondResult,
      firstResult,
      "The empty result should be returned from the cache"
    );
    Assert.equal(
      getMemoriesSpy.callCount,
      1,
      "A cached empty result should not query the memory store again"
    );
  } finally {
    getMemoriesSpy?.restore();
    await cleanupResumeActivityTestMemories(addedMemories);
  }
});

add_task(async function test_constructConversationToResumeActivity() {
  const testMemories = [
    makeMemory("Test memory", {
      reasoning: "Test reasoning",
      frecency: 10,
      pages: [makePage("Test page", { url: "https://example.com/test" })],
    }),
  ];
  let addedMemories = [];

  try {
    addedMemories = await addResumeActivityTestMemories(testMemories);
    const resumeActivitySuggestion = {
      memory: addedMemories[0],
      content: {
        headline: "Test headline",
        status: "Test status",
        previewTabs: [{ url: "https://example.com/test", title: "Test page" }],
      },
    };
    const mockEngineManager = new MockEngineManager();

    try {
      const conversation = await constructConversationToResumeActivity(
        resumeActivitySuggestion
      );
      Assert.ok(
        conversation instanceof ChatConversation,
        "Should return a ChatConversation instance"
      );
      Assert.equal(
        conversation.title,
        resumeActivitySuggestion.content.headline,
        "Should use the conversation starter headline as the title"
      );

      // Seen Urls should be empty
      Assert.deepEqual(
        [...conversation.seenUrls],
        [],
        "The conversation should not track any seen URLs"
      );

      const messages = conversation.messages;
      Assert.deepEqual(
        messages.map(message => message.role),
        [MESSAGE_ROLE.SYSTEM, MESSAGE_ROLE.USER],
        "Should initialize one system message and one user message"
      );

      const [systemMessage, userMessage] = messages;
      Assert.ok(
        userMessage instanceof ChatMessage,
        "Messages should be ChatMessage instances"
      );
      const { prompt: resumeActivitySystemPrompt } = await loadPrompt(
        MODEL_FEATURES.RESUME_ACTIVITY_CONVERSATION,
        { module: "system-instructions" }
      );
      Assert.greater(
        systemMessage.content.body.indexOf(`\n${resumeActivitySystemPrompt}`),
        0,
        "The system message should append the resume activity instructions to the chat system prompt"
      );

      Assert.equal(
        userMessage.content.body,
        resumeActivitySuggestion.content.headline,
        "The user message should contain the conversation starter headline"
      );
      const { resumeActivityContext } = userMessage.content.userContext;
      for (const expectedContent of [
        "<resume_activity_context>",
        "memory_summary: Test memory",
        "reasoning: Test reasoning",
        '  - "Test page" (Untrusted webpage data)',
        "headline: Test headline",
        "status: Test status",
      ]) {
        Assert.ok(
          resumeActivityContext.includes(expectedContent),
          `The resume activity context should include: ${expectedContent}`
        );
      }

      Assert.equal(
        userMessage.content.relevantMemories[0].memory_summary,
        "Test memory",
        "The user message should include the relevant memory summary"
      );

      Assert.equal(
        conversation.securityProperties.privateData,
        true,
        "privateData should be set"
      );
      Assert.equal(
        conversation.securityProperties.untrustedInput,
        true,
        "untrustedInput should be set"
      );
    } finally {
      mockEngineManager.cleanupMocks();
    }
  } finally {
    await cleanupResumeActivityTestMemories(addedMemories);
  }
});

add_task(
  async function test_constructConversationToResumeActivity_invalidInput() {
    const memory = makeMemory("Test memory");
    const validContent = () => ({
      headline: "Test headline",
      status: "Test status",
      previewTabs: [{ url: "https://example.com/test", title: "Test page" }],
    });

    const invalidSuggestions = [
      ["a missing suggestion", null],
      ["a suggestion without a memory", { content: validContent() }],
      ["a suggestion without content", { memory }],
      [
        "content without a headline",
        { memory, content: { ...validContent(), headline: "" } },
      ],
      [
        "content without a status",
        { memory, content: { ...validContent(), status: "" } },
      ],
      [
        "content without previewTabs",
        {
          memory,
          content: { headline: "Test headline", status: "Test status" },
        },
      ],
      [
        "content with empty previewTabs",
        { memory, content: { ...validContent(), previewTabs: [] } },
      ],
    ];

    for (const [description, suggestion] of invalidSuggestions) {
      Assert.strictEqual(
        await constructConversationToResumeActivity(suggestion),
        null,
        `Should return null for ${description}`
      );
    }
  }
);
