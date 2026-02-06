/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { openAIEngine, MODEL_FEATURES, DEFAULT_MODEL, parseVersion } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs"
  );

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const PREF_API_KEY = "browser.smartwindow.apiKey";
const PREF_ENDPOINT = "browser.smartwindow.endpoint";
const PREF_MODEL = "browser.smartwindow.model";

const API_KEY = "fake-key";
const ENDPOINT = "https://api.fake-endpoint.com/v1";

async function loadRemoteSettingsSnapshot() {
  const file = do_get_file("ai-window-prompts-remote-settings-snapshot.json");
  const data = await IOUtils.readUTF8(file.path);
  return JSON.parse(data);
}

let REAL_REMOTE_SETTINGS_SNAPSHOT;

add_setup(async function () {
  REAL_REMOTE_SETTINGS_SNAPSHOT = await loadRemoteSettingsSnapshot();
});

registerCleanupFunction(() => {
  for (let pref of [PREF_API_KEY, PREF_ENDPOINT, PREF_MODEL]) {
    if (Services.prefs.prefHasUserValue(pref)) {
      Services.prefs.clearUserPref(pref);
    }
  }
});

add_task(async function test_parseVersion_with_v_prefix() {
  const result = parseVersion("v1.0");
  Assert.ok(result, "Should parse version with v prefix");
  Assert.equal(result.major, 1, "Major version should be 1");
  Assert.equal(result.minor, 0, "Minor version should be 0");
  Assert.equal(result.original, "v1.0", "Original should be preserved");
});

add_task(async function test_parseVersion_without_v_prefix() {
  const result = parseVersion("1.0");
  Assert.ok(result, "Should parse version without v prefix");
  Assert.equal(result.major, 1, "Major version should be 1");
  Assert.equal(result.minor, 0, "Minor version should be 0");
  Assert.equal(result.original, "1.0", "Original should be preserved");
});

add_task(async function test_parseVersion_with_higher_numbers() {
  const result = parseVersion("2.15");
  Assert.ok(result, "Should parse version with higher numbers");
  Assert.equal(result.major, 2, "Major version should be 2");
  Assert.equal(result.minor, 15, "Minor version should be 15");
  Assert.equal(result.original, "2.15", "Original should be preserved");
});

add_task(async function test_parseVersion_invalid_format() {
  Assert.equal(
    parseVersion("v1"),
    null,
    "Should return null for version without minor"
  );
  Assert.equal(parseVersion("1"), null, "Should return null for single number");
  Assert.equal(
    parseVersion("v1.0.0"),
    null,
    "Should return null for three part version"
  );
  Assert.equal(
    parseVersion("invalid"),
    null,
    "Should return null for non-numeric version"
  );
});

add_task(async function test_parseVersion_edge_cases() {
  Assert.equal(parseVersion(""), null, "Should return null for empty string");
  Assert.equal(parseVersion(null), null, "Should return null for null");
  Assert.equal(
    parseVersion(undefined),
    null,
    "Should return null for undefined"
  );
  Assert.equal(
    parseVersion("v1.0extra"),
    null,
    "Should return null for version with extra text after"
  );
});

add_task(async function test_loadConfig_basic_with_real_snapshot() {
  Services.prefs.setStringPref(PREF_API_KEY, API_KEY);
  Services.prefs.setStringPref(PREF_ENDPOINT, ENDPOINT);

  const sb = sinon.createSandbox();
  try {
    const fakeEngine = {
      runWithGenerator() {
        throw new Error("not used");
      },
    };
    sb.stub(openAIEngine, "_createEngine").resolves(fakeEngine);

    sb.stub(openAIEngine, "getRemoteClient").returns({
      get: sb.stub().resolves(REAL_REMOTE_SETTINGS_SNAPSHOT),
    });

    const engine = new openAIEngine();

    await engine.loadConfig(MODEL_FEATURES.CHAT);

    Assert.equal(
      engine.feature,
      MODEL_FEATURES.CHAT,
      "Feature should be set correctly"
    );
    Assert.ok(engine.model, "Model should be loaded from remote settings");

    const config = engine.getConfig(MODEL_FEATURES.CHAT);
    Assert.ok(config, "Config should be loaded");
    Assert.ok(config.prompts, "Prompts should be loaded from remote settings");
    Assert.ok(
      config.prompts.includes("browser assistant"),
      "Prompts should contain expected content"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_loadConfig_with_user_pref_model() {
  Services.prefs.setStringPref(PREF_API_KEY, API_KEY);
  Services.prefs.setStringPref(PREF_ENDPOINT, ENDPOINT);
  Services.prefs.setStringPref(PREF_MODEL, "gpt-oss-120b");

  const sb = sinon.createSandbox();
  try {
    const fakeEngine = {
      runWithGenerator() {
        throw new Error("not used");
      },
    };
    sb.stub(openAIEngine, "_createEngine").resolves(fakeEngine);

    sb.stub(openAIEngine, "getRemoteClient").returns({
      get: sb.stub().resolves(REAL_REMOTE_SETTINGS_SNAPSHOT),
    });

    const engine = new openAIEngine();

    await engine.loadConfig(MODEL_FEATURES.CHAT);

    Assert.equal(
      engine.model,
      "gpt-oss-120b",
      "User pref model should filter to matching configs"
    );
    const config = engine.getConfig(MODEL_FEATURES.CHAT);
    Assert.equal(
      config.model,
      "gpt-oss-120b",
      "Selected config should be for user's preferred model"
    );
  } finally {
    sb.restore();
    Services.prefs.clearUserPref(PREF_MODEL);
  }
});

add_task(async function test_loadConfig_no_records() {
  Services.prefs.setStringPref(PREF_API_KEY, API_KEY);
  Services.prefs.setStringPref(PREF_ENDPOINT, ENDPOINT);

  const sb = sinon.createSandbox();
  try {
    const fakeEngine = {
      runWithGenerator() {
        throw new Error("not used");
      },
    };
    sb.stub(openAIEngine, "_createEngine").resolves(fakeEngine);

    sb.stub(openAIEngine, "getRemoteClient").returns({
      get: sb.stub().resolves([]),
    });

    const engine = new openAIEngine();

    await engine.loadConfig(MODEL_FEATURES.CHAT);

    Assert.equal(
      engine.model,
      "qwen3-235b-a22b-instruct-2507-maas",
      "Should fall back to default model when remote settings returns no records"
    );
    Assert.equal(
      engine.feature,
      MODEL_FEATURES.CHAT,
      "Should set feature when remote settings returns no records"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_loadConfig_filters_by_major_version() {
  Services.prefs.setStringPref(PREF_API_KEY, API_KEY);
  Services.prefs.setStringPref(PREF_ENDPOINT, ENDPOINT);

  const sb = sinon.createSandbox();
  try {
    const fakeEngine = {
      runWithGenerator() {
        throw new Error("not used");
      },
    };
    sb.stub(openAIEngine, "_createEngine").resolves(fakeEngine);

    // Add a v3.0 record to test data
    const recordsWithV3 = [
      ...REAL_REMOTE_SETTINGS_SNAPSHOT,
      {
        model: "future-model",
        feature: "chat",
        prompts: "Future version prompt",
        version: "v3.0",
        is_default: true,
      },
    ];

    sb.stub(openAIEngine, "getRemoteClient").returns({
      get: sb.stub().resolves(recordsWithV3),
    });

    const engine = new openAIEngine();
    await engine.loadConfig(MODEL_FEATURES.CHAT);

    const config = engine.getConfig(MODEL_FEATURES.CHAT);
    // Should get 1.x, not 3.0
    Assert.ok(config.version.startsWith("1."), "Should select 1.x, not 3.0");
  } finally {
    sb.restore();
  }
});

add_task(async function test_loadConfig_fallback_when_user_model_not_found() {
  Services.prefs.setStringPref(PREF_API_KEY, API_KEY);
  Services.prefs.clearUserPref(PREF_ENDPOINT);
  Services.prefs.setStringPref(PREF_MODEL, "nonexistent-model");

  const sb = sinon.createSandbox();
  try {
    const fakeEngine = {
      runWithGenerator() {
        throw new Error("not used");
      },
    };
    sb.stub(openAIEngine, "_createEngine").resolves(fakeEngine);

    sb.stub(openAIEngine, "getRemoteClient").returns({
      get: sb.stub().resolves(REAL_REMOTE_SETTINGS_SNAPSHOT),
    });

    const engine = new openAIEngine();
    await engine.loadConfig(MODEL_FEATURES.CHAT);

    // Should fall back to default model
    Assert.notEqual(
      engine.model,
      "nonexistent-model",
      "Should not use invalid user model"
    );
    const config = engine.getConfig(MODEL_FEATURES.CHAT);
    Assert.equal(config.is_default, true, "Should fall back to default config");
    Assert.equal(
      config.model,
      engine.model,
      "Engine model should match the default config's model"
    );
    Assert.equal(config.version, "1.0", "Should use 1.0");
  } finally {
    sb.restore();
    Services.prefs.clearUserPref(PREF_MODEL);
  }
});

add_task(async function test_loadConfig_custom_endpoint_with_custom_model() {
  Services.prefs.setStringPref(PREF_ENDPOINT, "http://localhost:11434/v1");
  Services.prefs.setStringPref(PREF_MODEL, "custom-model:7b");

  const sb = sinon.createSandbox();
  try {
    const engine = new openAIEngine();
    const fakeRecords = [
      {
        feature: MODEL_FEATURES.CHAT,
        version: "1.0",
        model: "some-other-model",
        is_default: true,
      },
    ];

    const fakeClient = {
      get: sb.stub().resolves(fakeRecords),
    };
    sb.stub(openAIEngine, "getRemoteClient").returns(fakeClient);

    await engine.loadConfig(MODEL_FEATURES.CHAT);

    Assert.equal(
      engine.model,
      "custom-model:7b",
      "Should use custom model with custom endpoint"
    );
  } finally {
    sb.restore();
    Services.prefs.clearUserPref(PREF_ENDPOINT);
    Services.prefs.clearUserPref(PREF_MODEL);
  }
});

add_task(async function test_loadConfig_custom_endpoint_without_custom_model() {
  Services.prefs.clearUserPref(PREF_MODEL);
  Services.prefs.clearUserPref(PREF_ENDPOINT);

  Services.prefs.setStringPref(PREF_ENDPOINT, "http://localhost:11434/v1");

  const sb = sinon.createSandbox();
  try {
    const engine = new openAIEngine();
    const fakeRecords = [
      {
        feature: MODEL_FEATURES.CHAT,
        version: "1.0",
        model: "remote-default-model",
        is_default: true,
      },
    ];

    const fakeClient = {
      get: sb.stub().resolves(fakeRecords),
    };
    sb.stub(openAIEngine, "getRemoteClient").returns(fakeClient);

    await engine.loadConfig(MODEL_FEATURES.CHAT);

    Assert.equal(
      engine.model,
      "qwen3-235b-a22b-instruct-2507-maas",
      "Should use default model from pref when custom endpoint is set"
    );
  } finally {
    sb.restore();
    Services.prefs.clearUserPref(PREF_ENDPOINT);
    Services.prefs.clearUserPref(PREF_MODEL);
  }
});

add_task(
  async function test_loadConfig_custom_endpoint_no_remote_settings_records() {
    Services.prefs.setStringPref(PREF_ENDPOINT, "http://localhost:11434/v1");
    Services.prefs.setStringPref(PREF_MODEL, "local-llama-model");

    const sb = sinon.createSandbox();
    try {
      const engine = new openAIEngine();
      const fakeClient = {
        get: sb.stub().resolves([]),
      };
      sb.stub(openAIEngine, "getRemoteClient").returns(fakeClient);

      await engine.loadConfig(MODEL_FEATURES.CHAT);

      Assert.equal(
        engine.model,
        "local-llama-model",
        "Should use custom model even when Remote Settings has no records"
      );
    } finally {
      sb.restore();
      Services.prefs.clearUserPref(PREF_ENDPOINT);
      Services.prefs.clearUserPref(PREF_MODEL);
    }
  }
);

add_task(
  async function test_loadConfig_no_custom_endpoint_no_remote_settings() {
    Services.prefs.clearUserPref(PREF_ENDPOINT);
    Services.prefs.setStringPref(PREF_MODEL, "some-model");

    const sb = sinon.createSandbox();
    try {
      const engine = new openAIEngine();
      const fakeClient = {
        get: sb.stub().resolves([]),
      };
      sb.stub(openAIEngine, "getRemoteClient").returns(fakeClient);

      await engine.loadConfig(MODEL_FEATURES.CHAT);

      Assert.equal(
        engine.model,
        DEFAULT_MODEL[MODEL_FEATURES.CHAT],
        "Should fall back to default model when no custom endpoint and no Remote Settings"
      );
    } finally {
      sb.restore();
      Services.prefs.clearUserPref(PREF_MODEL);
    }
  }
);

add_task(async function test_loadPrompt_from_remote_settings() {
  Services.prefs.setStringPref(PREF_API_KEY, API_KEY);
  Services.prefs.setStringPref(PREF_ENDPOINT, ENDPOINT);

  const sb = sinon.createSandbox();
  try {
    const fakeEngine = {
      runWithGenerator() {
        throw new Error("not used");
      },
    };
    sb.stub(openAIEngine, "_createEngine").resolves(fakeEngine);

    sb.stub(openAIEngine, "getRemoteClient").returns({
      get: sb.stub().resolves(REAL_REMOTE_SETTINGS_SNAPSHOT),
    });

    const engine = new openAIEngine();
    await engine.loadConfig(MODEL_FEATURES.TITLE_GENERATION);

    const prompt = await engine.loadPrompt(MODEL_FEATURES.TITLE_GENERATION);

    Assert.ok(prompt, "Prompt should be loaded from remote settings");
    Assert.ok(
      prompt.includes("title") || prompt.includes("conversation"),
      "Prompt should contain expected content for title generation"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_loadPrompt_fallback_to_local() {
  Services.prefs.setStringPref(PREF_API_KEY, API_KEY);
  Services.prefs.setStringPref(PREF_ENDPOINT, ENDPOINT);

  const sb = sinon.createSandbox();
  try {
    const fakeEngine = {
      runWithGenerator() {
        throw new Error("not used");
      },
    };
    sb.stub(openAIEngine, "_createEngine").resolves(fakeEngine);

    sb.stub(openAIEngine, "getRemoteClient").returns({
      get: sb.stub().resolves([]),
    });

    const engine = new openAIEngine();
    await engine.loadConfig(MODEL_FEATURES.TITLE_GENERATION);

    const prompt = await engine.loadPrompt(MODEL_FEATURES.TITLE_GENERATION);

    Assert.ok(prompt, "Prompt should fallback to local prompt");
    Assert.ok(
      prompt.includes("Generate a concise chat title"),
      "Should load local prompt when remote settings has no config"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_build_with_feature() {
  Services.prefs.setStringPref(PREF_API_KEY, API_KEY);
  Services.prefs.setStringPref(PREF_ENDPOINT, ENDPOINT);

  const sb = sinon.createSandbox();
  try {
    const fakeEngine = {
      runWithGenerator() {
        throw new Error("not used");
      },
    };
    const createEngineStub = sb
      .stub(openAIEngine, "_createEngine")
      .resolves(fakeEngine);

    sb.stub(openAIEngine, "getRemoteClient").returns({
      get: sb.stub().resolves(REAL_REMOTE_SETTINGS_SNAPSHOT),
    });

    const engine = await openAIEngine.build(MODEL_FEATURES.CHAT);

    Assert.ok(engine.engineInstance, "Engine instance should be created");
    Assert.equal(engine.feature, MODEL_FEATURES.CHAT, "Feature should be set");
    Assert.ok(engine.model, "Model should be loaded from remote settings");

    const opts = createEngineStub.firstCall.args[0];
    Assert.ok(opts.modelId, "Model should be passed to engine creation");
    Assert.equal(
      opts.modelId,
      engine.model,
      "Model passed to engine should match loaded model"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_inference_params_from_config() {
  Services.prefs.setStringPref(PREF_API_KEY, API_KEY);
  Services.prefs.setStringPref(PREF_ENDPOINT, ENDPOINT);

  const sb = sinon.createSandbox();
  try {
    const fakeEngine = {
      runWithGenerator() {
        throw new Error("not used");
      },
    };
    sb.stub(openAIEngine, "_createEngine").resolves(fakeEngine);

    sb.stub(openAIEngine, "getRemoteClient").returns({
      get: sb.stub().resolves(REAL_REMOTE_SETTINGS_SNAPSHOT),
    });

    const engine = new openAIEngine();
    await engine.loadConfig(MODEL_FEATURES.CHAT);

    const config = engine.getConfig(MODEL_FEATURES.CHAT);
    Assert.ok(config, "Config should be loaded");

    const inferenceParams = config?.parameters || {};
    Assert.equal(
      typeof inferenceParams,
      "object",
      "Inference parameters should be an object"
    );
    Assert.equal(
      inferenceParams.temperature,
      1.0,
      "Temperature should be loaded from parameters"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_loadConfig_with_additional_components() {
  Services.prefs.setStringPref(PREF_API_KEY, API_KEY);
  Services.prefs.setStringPref(PREF_ENDPOINT, ENDPOINT);

  const sb = sinon.createSandbox();
  try {
    const fakeEngine = {
      runWithGenerator() {
        throw new Error("not used");
      },
    };
    sb.stub(openAIEngine, "_createEngine").resolves(fakeEngine);

    const fakeRecords = [
      {
        feature: "memories-initial-generation-system",
        version: "1.0",
        model: "test-model",
        is_default: true,
        prompts: "System prompt for memory generation",
        additional_components:
          "[memories-initial-generation-user, memories-deduplication-system]",
        parameters: "{}",
      },
      {
        feature: "memories-initial-generation-user",
        version: "1.0",
        model: "test-model",
        prompts: "User prompt for memory generation",
      },
      {
        feature: "memories-deduplication-system",
        version: "1.0",
        model: "test-model",
        prompts: "System prompt for deduplication",
      },
    ];

    sb.stub(openAIEngine, "getRemoteClient").returns({
      get: sb.stub().resolves(fakeRecords),
    });

    const engine = new openAIEngine();
    await engine.loadConfig("memories-initial-generation-system");

    const mainConfig = engine.getConfig("memories-initial-generation-system");
    Assert.ok(mainConfig, "Main config should be loaded");
    Assert.equal(
      mainConfig.prompts,
      "System prompt for memory generation",
      "Main prompt should be loaded"
    );

    const userPromptConfig = engine.getConfig(
      "memories-initial-generation-user"
    );
    Assert.ok(userPromptConfig, "Additional component config should be loaded");
    Assert.equal(
      userPromptConfig.prompts,
      "User prompt for memory generation",
      "Additional component prompt should be loaded"
    );

    const dedupConfig = engine.getConfig("memories-deduplication-system");
    Assert.ok(dedupConfig, "Second additional component should be loaded");
    Assert.equal(
      dedupConfig.prompts,
      "System prompt for deduplication",
      "Second additional component prompt should be loaded"
    );

    const systemPrompt = await engine.loadPrompt(
      "memories-initial-generation-system"
    );
    Assert.equal(
      systemPrompt,
      "System prompt for memory generation",
      "Should load system prompt from config"
    );

    const userPrompt = await engine.loadPrompt(
      "memories-initial-generation-user"
    );
    Assert.equal(
      userPrompt,
      "User prompt for memory generation",
      "Should load user prompt from additional components"
    );
  } finally {
    sb.restore();
  }
});
