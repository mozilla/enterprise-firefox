/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  InferredPersonalizationFeed:
    "resource://newtab/lib/InferredPersonalizationFeed.sys.mjs",
  sinon: "resource://testing-common/Sinon.sys.mjs",
});

const AT = {
  INFERRED_PERSONALIZATION_REFRESH: "INFERRED_PERSONALIZATION_REFRESH",
  INFERRED_PERSONALIZATION_DEBUG_FEATURES_REQUEST:
    "INFERRED_PERSONALIZATION_DEBUG_FEATURES_REQUEST",
  INFERRED_PERSONALIZATION_DEBUG_FEATURES_UPDATE:
    "INFERRED_PERSONALIZATION_DEBUG_FEATURES_UPDATE",
  INFERRED_PERSONALIZATION_DEBUG_OVERRIDES_SET:
    "INFERRED_PERSONALIZATION_DEBUG_OVERRIDES_SET",
};

function expectedBroadcast(type, data) {
  return {
    type,
    data,
    meta: {
      from: "ActivityStream:Main",
      to: "ActivityStream:Content",
    },
  };
}

/**
 * Test inferred personalization feed constructor from InferredPersonalizationFeed.sys.mjs.
 */
add_task(async function test_InferredPersonalizationFeed_constructor() {
  const sandbox = sinon.createSandbox();
  sandbox
    .stub(InferredPersonalizationFeed.prototype, "PersistentCache")
    .returns({
      set: () => {},
      get: () => {},
    });

  let feed = new InferredPersonalizationFeed();

  ok(feed instanceof InferredPersonalizationFeed, "Feed is constructed");
  sandbox.restore();
});

/**
 * Test inferred personalization feed method clearOldDataOfTable from InferredPersonalizationFeed.sys.mjs.
 * We pass a fake placesUtils to verify the SQL query and dates are correct.
 */
add_task(async function test_clearOldDataOfTable() {
  const sandbox = sinon.createSandbox();
  sandbox
    .stub(InferredPersonalizationFeed.prototype, "PersistentCache")
    .returns({
      set: () => {},
      get: () => {},
    });

  const FIXED_TIMESTAMP_MS = 1672531200000;
  sandbox.stub(InferredPersonalizationFeed.prototype, "Date").returns({
    now: () => FIXED_TIMESTAMP_MS,
  });

  const feed = new InferredPersonalizationFeed();

  let sqlUsed;
  let wrapperNameUsed;
  let wrapperCalled = 0;

  const fakePlacesUtils = {
    withConnectionWrapper: async (name, callback) => {
      wrapperCalled++;
      wrapperNameUsed = name;
      const fakeDB = {
        execute: async sql => {
          sqlUsed = sql;
          return [];
        },
      };
      return callback(fakeDB);
    },
  };

  const preserveAgeDays = 7;
  const table = "test_table";

  const expectedTimestamp =
    Math.floor(FIXED_TIMESTAMP_MS / 1000) - preserveAgeDays * 24 * 60 * 60;

  await feed.clearOldDataOfTable(preserveAgeDays, table, fakePlacesUtils);

  const expectedSQL = `DELETE FROM ${table}
      WHERE timestamp_s < ${expectedTimestamp}`;

  equal(wrapperCalled, 1, "withConnectionWrapper was called once");
  ok(
    wrapperNameUsed.includes("clearOldDataOfTable"),
    "withConnectionWrapper name includes clearOldDataOfTable"
  );
  equal(
    sqlUsed.replace(/\s+/g, " ").trim(),
    expectedSQL.replace(/\s+/g, " ").trim(),
    "SQL query is as expected"
  );

  sandbox.restore();
});

const TEST_MODEL_DATA = {
  model_type: "clicks",
  day_time_weighting: {
    days: [3, 14, 45],
    relative_weight: [1, 0.5, 0.3],
  },
  interest_vector: {
    news_reader: {
      features: { pub_nytimes_com: 0.5, pub_cnn_com: 0.5 },
      thresholds: [0.3, 0.4],
      diff_p: 1,
      diff_q: 0,
    },
    parenting: {
      features: { parenting: 1 },
      thresholds: [0.3, 0.4],
      diff_p: 1,
      diff_q: 0,
    },
    clicks: {
      features: { click: 1 },
      thresholds: [10, 30],
      diff_p: 1,
      diff_q: 0,
    },
  },
};

add_task(
  async function test_getDebuggingInterestFeaturesSupported_noModelData() {
    const sandbox = sinon.createSandbox();
    const fakeCache = {
      set: sandbox.stub().resolves(),
      get: sandbox.stub().resolves(null),
    };
    sandbox
      .stub(InferredPersonalizationFeed.prototype, "PersistentCache")
      .returns(fakeCache);

    const feed = new InferredPersonalizationFeed();
    sandbox.stub(feed, "getInferredModelData").resolves(null);

    const result = await feed.getDebuggingInterestFeaturesSupported();

    deepEqual(result, {}, "Returns empty object when no model data");

    sandbox.restore();
  }
);

add_task(async function test_setAndGetDebuggingInterestFeatures_integration() {
  const sandbox = sinon.createSandbox();

  let cacheStorage = {};
  const fakeCache = {
    set: sandbox.stub().callsFake((key, value) => {
      cacheStorage[key] = value;
      return Promise.resolve();
    }),
    get: sandbox.stub().callsFake(key => {
      return Promise.resolve(cacheStorage[key] || null);
    }),
  };
  sandbox
    .stub(InferredPersonalizationFeed.prototype, "PersistentCache")
    .returns(fakeCache);

  const feed = new InferredPersonalizationFeed();

  const mockModelData = {
    model_id: "test_model",
    model_data: TEST_MODEL_DATA,
    getInterestFeaturesSupported() {
      return {
        news_reader: { numValues: 3 },
        parenting: { numValues: 3 },
        clicks: { numValues: 3 },
      };
    },
  };

  const mockInterestVector = {
    data: {
      coarseInferredInterests: {
        news_reader: 1,
        parenting: 2,
      },
    },
  };

  sandbox.stub(feed, "getInferredModelData").resolves(mockModelData);
  cacheStorage.interest_vector = mockInterestVector;

  const resultBefore = await feed.getDebuggingInterestFeaturesSupported();

  equal(
    resultBefore.news_reader.currentValue,
    1,
    "Initial news_reader currentValue is 1"
  );
  equal(
    resultBefore.news_reader.overrideValue,
    undefined,
    "Initially no override for news_reader"
  );
  equal(
    resultBefore.parenting.currentValue,
    2,
    "Initial parenting currentValue is 2"
  );
  equal(
    resultBefore.parenting.overrideValue,
    undefined,
    "Initially no override for parenting"
  );

  const overrides = {
    news_reader: 0,
    parenting: 3,
    clicks: 2,
  };
  await feed.setDebuggingInterestFeaturesOverride(overrides);

  const resultAfter = await feed.getDebuggingInterestFeaturesSupported();

  equal(
    resultAfter.news_reader.currentValue,
    1,
    "news_reader currentValue unchanged"
  );
  equal(
    resultAfter.news_reader.overrideValue,
    0,
    "news_reader now has overrideValue of 0"
  );
  equal(
    resultAfter.parenting.currentValue,
    2,
    "parenting currentValue unchanged"
  );
  equal(
    resultAfter.parenting.overrideValue,
    3,
    "parenting now has overrideValue of 3"
  );
  equal(
    resultAfter.clicks.currentValue,
    undefined,
    "clicks has no currentValue"
  );
  equal(
    resultAfter.clicks.overrideValue,
    2,
    "clicks now has overrideValue of 2"
  );

  await feed.setDebuggingInterestFeaturesOverride(null);

  const resultCleared = await feed.getDebuggingInterestFeaturesSupported();

  equal(
    resultCleared.news_reader.currentValue,
    1,
    "news_reader currentValue still present after clearing"
  );
  equal(
    resultCleared.news_reader.overrideValue,
    undefined,
    "news_reader overrideValue cleared"
  );
  equal(
    resultCleared.parenting.overrideValue,
    undefined,
    "parenting overrideValue cleared"
  );
  equal(
    resultCleared.clicks.overrideValue,
    undefined,
    "clicks overrideValue cleared"
  );

  sandbox.restore();
});

add_task(
  async function test_onAction_refresh_reloads_and_broadcasts_features() {
    const sandbox = sinon.createSandbox();
    sandbox
      .stub(InferredPersonalizationFeed.prototype, "PersistentCache")
      .returns({
        set: () => {},
        get: () => {},
      });

    const feed = new InferredPersonalizationFeed();
    const dispatch = sandbox.stub();
    feed.store = {
      dispatch,
      getState: () => ({
        Prefs: {
          values: {
            "discoverystream.sections.personalization.inferred.user.enabled": true,
            "discoverystream.sections.personalization.inferred.enabled": true,
          },
        },
      }),
    };
    const features = { arts: { numValues: 4, currentValue: 1 } };
    const resetStub = sandbox.stub(feed, "reset").resolves();
    const loadStub = sandbox.stub(feed, "loadInterestVector").resolves();
    sandbox
      .stub(feed, "getDebuggingInterestFeaturesSupported")
      .resolves(features);

    await feed.onAction({ type: AT.INFERRED_PERSONALIZATION_REFRESH });

    Assert.equal(
      resetStub.callCount,
      1,
      "Refresh clears previous cached values"
    );
    Assert.equal(loadStub.callCount, 1, "Refresh recomputes inferred values");
    deepEqual(
      dispatch.lastCall.args[0],
      expectedBroadcast(
        AT.INFERRED_PERSONALIZATION_DEBUG_FEATURES_UPDATE,
        features
      ),
      "Refresh broadcasts debug features after recompute"
    );

    sandbox.restore();
  }
);

add_task(
  async function test_onAction_debug_features_request_broadcasts_features() {
    const sandbox = sinon.createSandbox();
    sandbox
      .stub(InferredPersonalizationFeed.prototype, "PersistentCache")
      .returns({
        set: () => {},
        get: () => {},
      });

    const feed = new InferredPersonalizationFeed();
    const dispatch = sandbox.stub();
    feed.store = { dispatch, getState: () => ({ Prefs: { values: {} } }) };
    const features = { arts: { numValues: 4, currentValue: 1 } };
    sandbox
      .stub(feed, "getDebuggingInterestFeaturesSupported")
      .resolves(features);

    await feed.onAction({
      type: AT.INFERRED_PERSONALIZATION_DEBUG_FEATURES_REQUEST,
    });

    deepEqual(
      dispatch.lastCall.args[0],
      expectedBroadcast(
        AT.INFERRED_PERSONALIZATION_DEBUG_FEATURES_UPDATE,
        features
      ),
      "Debug feature request broadcasts current debug metadata"
    );

    sandbox.restore();
  }
);

add_task(
  async function test_onAction_debug_overrides_set_stores_and_rebroadcasts() {
    const sandbox = sinon.createSandbox();
    sandbox
      .stub(InferredPersonalizationFeed.prototype, "PersistentCache")
      .returns({
        set: () => {},
        get: () => {},
      });

    const feed = new InferredPersonalizationFeed();
    const dispatch = sandbox.stub();
    feed.store = { dispatch, getState: () => ({ Prefs: { values: {} } }) };
    const overrides = { arts: 2, sports: 1 };
    const features = {
      arts: { numValues: 4, currentValue: 1, overrideValue: 2 },
      sports: { numValues: 4, currentValue: 0, overrideValue: 1 },
    };
    const setStub = sandbox
      .stub(feed, "setDebuggingInterestFeaturesOverride")
      .resolves();
    sandbox
      .stub(feed, "getDebuggingInterestFeaturesSupported")
      .resolves(features);

    await feed.onAction({
      type: AT.INFERRED_PERSONALIZATION_DEBUG_OVERRIDES_SET,
      data: overrides,
    });

    Assert.equal(
      setStub.callCount,
      1,
      "Overrides action stores override payload"
    );
    deepEqual(
      setStub.firstCall.args[0],
      overrides,
      "Overrides are passed through to storage method"
    );
    deepEqual(
      dispatch.lastCall.args[0],
      expectedBroadcast(
        AT.INFERRED_PERSONALIZATION_DEBUG_FEATURES_UPDATE,
        features
      ),
      "Setting overrides rebroadcasts updated debug metadata"
    );

    sandbox.restore();
  }
);
