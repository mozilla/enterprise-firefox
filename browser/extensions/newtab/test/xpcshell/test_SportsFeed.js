/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  actionTypes: "resource://newtab/common/Actions.mjs",
  SportsFeed: "resource://newtab/lib/Widgets/SportsFeed.sys.mjs",
  sinon: "resource://testing-common/Sinon.sys.mjs",
});

const PREF_SPORTS_ENABLED = "widgets.sportsWidget.enabled";

function makeFeed({ enabled = true } = {}) {
  const feed = new SportsFeed();
  feed.store = {
    getState() {
      return this.state;
    },
    dispatch: sinon.spy(),
    state: {
      Prefs: {
        values: {
          [PREF_SPORTS_ENABLED]: enabled,
        },
      },
    },
  };
  return feed;
}

add_task(async function test_construction() {
  const feed = makeFeed();

  info("SportsFeed constructor should create initial values");
  Assert.ok(feed, "Could construct a SportsFeed");
  Assert.ok(!feed.initialized, "SportsFeed is not initialized");
});

add_task(async function test_enabled() {
  info("SportsFeed.enabled returns true when the pref is on");
  Assert.ok(makeFeed({ enabled: true }).enabled);

  info("SportsFeed.enabled returns false when the pref is off");
  Assert.ok(!makeFeed({ enabled: false }).enabled);
});

add_task(async function test_onAction_INIT_when_enabled() {
  const feed = makeFeed({ enabled: true });

  info("SportsFeed.onAction INIT should set initialized when enabled");
  await feed.onAction({ type: actionTypes.INIT });

  Assert.ok(feed.initialized, "feed.initialized should be true after INIT");
});

add_task(async function test_onAction_INIT_when_disabled() {
  const feed = makeFeed({ enabled: false });

  info("SportsFeed.onAction INIT should not initialize when disabled");
  await feed.onAction({ type: actionTypes.INIT });

  Assert.ok(!feed.initialized, "feed.initialized should remain false");
});

add_task(async function test_onAction_PREF_CHANGED_initializes() {
  const feed = makeFeed({ enabled: true });

  info("SportsFeed.onAction PREF_CHANGED should initialize when pref turns on");
  await feed.onAction({
    type: actionTypes.PREF_CHANGED,
    data: { name: PREF_SPORTS_ENABLED, value: true },
  });

  Assert.ok(
    feed.initialized,
    "feed.initialized should be true after pref enabled"
  );
});

add_task(async function test_syncState_broadcasts_widgetState() {
  const feed = makeFeed();
  const getStub = sinon.stub(feed.cache, "get").resolves({
    widgetState: "sports-intro",
  });

  info("syncState should broadcast widgetState from cache to the UI");
  await feed.syncState();

  const [firstCall] = feed.store.dispatch.getCalls();
  Assert.equal(
    firstCall.args[0].type,
    actionTypes.WIDGETS_SPORTS_SET_WIDGET_STATE,
    "dispatches SET_WIDGET_STATE"
  );
  Assert.equal(firstCall.args[0].data, "sports-intro", "with correct state");

  getStub.restore();
});

add_task(async function test_syncState_broadcasts_selectedTeams() {
  const feed = makeFeed();
  const getStub = sinon.stub(feed.cache, "get").resolves({
    selectedTeams: ["CA", "AU"],
  });

  info("syncState should broadcast selectedTeams from cache to the UI");
  await feed.syncState();

  const [firstCall] = feed.store.dispatch.getCalls();
  Assert.equal(
    firstCall.args[0].type,
    actionTypes.WIDGETS_SPORTS_SET_SELECTED_TEAMS,
    "dispatches SET_SELECTED_TEAMS"
  );
  Assert.deepEqual(firstCall.args[0].data, ["CA", "AU"], "with correct teams");

  getStub.restore();
});

add_task(async function test_syncState_empty_cache() {
  const feed = makeFeed();
  const getStub = sinon.stub(feed.cache, "get").resolves({});

  info("syncState should not dispatch when cache is empty");
  await feed.syncState();

  Assert.equal(feed.store.dispatch.callCount, 0, "no dispatch on empty cache");

  getStub.restore();
});

add_task(async function test_CHANGE_WIDGET_STATE_saves_and_broadcasts() {
  const feed = makeFeed();
  const setStub = sinon.stub(feed.cache, "set").resolves();

  info("CHANGE_WIDGET_STATE should save to cache and broadcast to the UI");
  await feed.onAction({
    type: actionTypes.WIDGETS_SPORTS_CHANGE_WIDGET_STATE,
    data: "sports-intro",
  });

  Assert.ok(setStub.calledOnce, "cache.set called once");
  Assert.equal(setStub.firstCall.args[0], "widgetState");
  Assert.equal(setStub.firstCall.args[1], "sports-intro");

  const [firstDispatch] = feed.store.dispatch.getCalls();
  Assert.equal(
    firstDispatch.args[0].type,
    actionTypes.WIDGETS_SPORTS_SET_WIDGET_STATE,
    "dispatches SET_WIDGET_STATE"
  );
  Assert.equal(firstDispatch.args[0].data, "sports-intro");

  setStub.restore();
});

add_task(async function test_CHANGE_WIDGET_STATE_follow_state_skips_cache() {
  const feed = makeFeed();
  const setStub = sinon.stub(feed.cache, "set").resolves();

  info(
    "CHANGE_WIDGET_STATE with the follow state should skip saving but still broadcast"
  );
  await feed.onAction({
    type: actionTypes.WIDGETS_SPORTS_CHANGE_WIDGET_STATE,
    data: "sports-follow-state",
  });

  Assert.ok(
    setStub.notCalled,
    "cache.set should not be called for follow state"
  );

  const [firstDispatch] = feed.store.dispatch.getCalls();
  Assert.equal(
    firstDispatch.args[0].type,
    actionTypes.WIDGETS_SPORTS_SET_WIDGET_STATE,
    "still dispatches SET_WIDGET_STATE"
  );
  Assert.equal(firstDispatch.args[0].data, "sports-follow-state");

  setStub.restore();
});

add_task(async function test_CHANGE_SELECTED_TEAMS_saves_and_broadcasts() {
  const feed = makeFeed();
  const setStub = sinon.stub(feed.cache, "set").resolves();

  info("CHANGE_SELECTED_TEAMS should save to cache and broadcast to the UI");
  await feed.onAction({
    type: actionTypes.WIDGETS_SPORTS_CHANGE_SELECTED_TEAMS,
    data: ["CA", "AU"],
  });

  Assert.ok(setStub.calledOnce, "cache.set called once");
  Assert.equal(setStub.firstCall.args[0], "selectedTeams");
  Assert.deepEqual(setStub.firstCall.args[1], ["CA", "AU"]);

  const [firstDispatch] = feed.store.dispatch.getCalls();
  Assert.equal(
    firstDispatch.args[0].type,
    actionTypes.WIDGETS_SPORTS_SET_SELECTED_TEAMS,
    "dispatches SET_SELECTED_TEAMS"
  );
  Assert.deepEqual(firstDispatch.args[0].data, ["CA", "AU"]);

  setStub.restore();
});
