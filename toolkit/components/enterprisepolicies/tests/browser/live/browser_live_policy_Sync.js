/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// The feature the Sync policy disallows when it locks the sync state.
const SYNC_FEATURE = "sync";

// The feature the Sync policy disallows when it locks the open tabs engine state.
const SYNC_FEATURE_TABS = "sync-tabs";

function checkSyncFeatureAllowed(expectedAllowed) {
  Assert.equal(
    Services.policies.isAllowed(SYNC_FEATURE),
    expectedAllowed,
    `${SYNC_FEATURE} feature is ${expectedAllowed ? "allowed" : "disallowed"}`
  );
}

function checkSyncTabsFeatureAllowed(expectedAllowed) {
  Assert.equal(
    Services.policies.isAllowed(SYNC_FEATURE_TABS),
    expectedAllowed,
    `${SYNC_FEATURE_TABS} feature is ${
      expectedAllowed ? "allowed" : "disallowed"
    }`
  );
}

async function updatePolicies(policies) {
  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies(policies);
  await updateApplied;
}

function getSyncedTabsTool() {
  return SidebarController.getTools().find(
    tool => tool.commandID == "viewTabsSidebar"
  );
}

// The synced tabs sidebar tool reflects its `visible` getter live, refreshed by
// SidebarController's policy observer; wait for it to settle after a change.
async function checkSyncedTabsTool(expectedHidden) {
  await TestUtils.waitForCondition(
    () => getSyncedTabsTool().hidden === expectedHidden,
    `Synced tabs sidebar tool should be ${
      expectedHidden ? "hidden" : "visible"
    }`
  );
  is(
    getSyncedTabsTool().hidden,
    expectedHidden,
    `Synced tabs sidebar tool hidden=${expectedHidden}`
  );
}

// The gating runs from a popupshowing handler, and the menubar is drawn natively
// on macOS where a test can't open its menus, so dispatch the events instead.
// popuphidden has to follow: showing opens the view's Places container, and
// leaving it open past the end of the test hangs shutdown.
function fireMenuPopupCycle(popupId, assertionCallback) {
  const popup = document.getElementById(popupId);
  popup.dispatchEvent(new Event("popupshowing", { bubbles: true }));
  try {
    assertionCallback();
  } finally {
    popup.dispatchEvent(new Event("popuphidden", { bubbles: true }));
  }
}

async function withPinnedUIState(state, assertionCallback) {
  const oldGet = UIState.get;
  UIState.get = () => state;
  try {
    await assertionCallback();
  } finally {
    UIState.get = oldGet;
  }
}

async function checkHistoryMenuSyncedTabsHidden(expectedHidden) {
  await withPinnedUIState(SIGNED_IN_SYNC_OFF, () => {
    fireMenuPopupCycle("historyMenuPopup", () => {
      is(
        document.getElementById("historyRemoteTabsPromo").hidden,
        expectedHidden,
        `History menu synced tabs promo hidden=${expectedHidden}`
      );
      ok(
        document.getElementById("sync-tabs-menuitem").hidden,
        "The synced tabs menuitem stays hidden while Sync is off"
      );
    });
  });
}

async function checkBookmarksMenuPromoHidden(expectedHidden) {
  await withPinnedUIState(SIGNED_IN_SYNC_OFF, () => {
    fireMenuPopupCycle("bookmarksMenuPopup", () => {
      is(
        document.getElementById("bookmarksRemoteTabsPromo").hidden,
        expectedHidden,
        `Bookmarks menu sync promo hidden=${expectedHidden}`
      );
    });
  });
}

// Firefox View reads the sync-tabs gating on load, so open a fresh tab to check
// how the "Tabs from other devices" nav renders under the current policy.
async function checkFirefoxViewSyncedTabsHidden(expectedHidden) {
  await BrowserTestUtils.withNewTab("about:firefoxview", async browser => {
    const doc = browser.contentDocument;
    const navButton = await TestUtils.waitForCondition(() =>
      doc.querySelector('moz-page-nav-button[view="syncedtabs"]')
    );
    await TestUtils.waitForCondition(
      () => navButton.hidden === expectedHidden,
      `Firefox View synced tabs nav should be ${
        expectedHidden ? "hidden" : "visible"
      }`
    );
    is(
      navButton.hidden,
      expectedHidden,
      `Firefox View synced tabs nav hidden=${expectedHidden}`
    );
  });
}

const { UIState } = ChromeUtils.importESModule(
  "resource://services-sync/UIState.sys.mjs"
);
const { getFxAccountsSingleton } = ChromeUtils.importESModule(
  "resource://gre/modules/FxAccounts.sys.mjs"
);

// The sync pane renders from UIState, so we mock it to reach the signed-in
// states that expose the controls gated on the sync feature.
const SIGNED_IN_SYNC_ON = {
  status: UIState.STATUS_SIGNED_IN,
  email: "test@example.com",
  displayName: "Test User",
  syncEnabled: true,
};

const SIGNED_IN_SYNC_OFF = {
  status: UIState.STATUS_SIGNED_IN,
  email: "test@example.com",
  displayName: "Test User",
  syncEnabled: false,
};

// Open the settings sync pane with a mocked UIState and run a check
// against its document.
async function withSyncPane(uiStateData, assertionCallback) {
  const oldGet = UIState.get;
  UIState.get = () => uiStateData;

  const paneLoaded = TestUtils.topicObserved("sync-pane-loaded", () => true);
  gBrowser.selectedTab = BrowserTestUtils.addTab(gBrowser, "about:blank", {
    allowInheritPrincipal: true,
  });
  openPreferences("paneSync");
  await paneLoaded;

  const doc = gBrowser.contentDocument;

  // The sync settings render from the mocked UIState during pane load; wait for
  // the signed-in state to be reflected before asserting.
  await TestUtils.waitForCondition(() => {
    const signedIn = doc.getElementById("fxaSignedInGroup");
    return signedIn && BrowserTestUtils.isVisible(signedIn);
  }, "the signed-in account state is rendered");

  try {
    await assertionCallback(doc);
  } finally {
    UIState.get = oldGet;
    BrowserTestUtils.removeTab(gBrowser.selectedTab);
  }
}

function syncGroup(doc) {
  return doc.querySelector('setting-group[groupid="sync"]');
}

// The Disconnect control only appears while Sync is on.
async function checkDisconnect(expectedHidden) {
  await withSyncPane(SIGNED_IN_SYNC_ON, doc => {
    const group = syncGroup(doc);
    ok(
      !BrowserTestUtils.isHidden(group.querySelector("#syncConfigured")),
      "The 'Sync is on' section is shown for a signed-in, syncing user."
    );
    is(
      BrowserTestUtils.isHidden(group.querySelector("#syncDisconnect")),
      expectedHidden,
      `The Disconnect button is ${expectedHidden ? "hidden" : "shown"}.`
    );
  });
}

// The "Sync is off" section only appears while Sync is off.
async function checkTurnOn(expectedHidden) {
  await withSyncPane(SIGNED_IN_SYNC_OFF, doc => {
    const group = syncGroup(doc);
    is(
      BrowserTestUtils.isHidden(group.querySelector("#syncNotConfigured")),
      expectedHidden,
      `The 'Sync is off' section is ${expectedHidden ? "hidden" : "shown"}.`
    );
    is(
      BrowserTestUtils.isHidden(group.querySelector("#syncSetup")),
      expectedHidden,
      `The 'Turn on syncing' button is ${expectedHidden ? "hidden" : "shown"}.`
    );
  });
}

// Fake a signed-in FxA account with sync keys so the policy's connect path
// (Service.configure) succeeds. Returns a function that restores the originals.
function mockSignedInAccount() {
  const fxAccounts = getFxAccountsSingleton();
  const originalGetSignedInUser = fxAccounts.getSignedInUser;
  const originalHasKeysForScope = fxAccounts.keys.hasKeysForScope;
  fxAccounts.getSignedInUser = () =>
    Promise.resolve({ email: "test@example.com", uid: "12345" });
  fxAccounts.keys.hasKeysForScope = () => Promise.resolve(true);
  return () => {
    fxAccounts.getSignedInUser = originalGetSignedInUser;
    fxAccounts.keys.hasKeysForScope = originalHasKeysForScope;
  };
}

add_setup(async function () {
  // gSync.init() runs in a requestIdleCallback; the gating no-ops until it has.
  gSync.init();

  await SpecialPowers.pushPrefEnv({
    // The mocked signed-in UIState has no real FxA account, so the urlbar trust
    // panel's breach check logs NO_ACCOUNT errors on the tab switch into the sync
    // pane. It is unrelated to these tests, so turn it off.
    set: [["browser.urlbar.trustPanel.featureGate", false]],
  });
});

// Sync locked and enabled: Hides the Disconnect control.
// Sync locked and disabled: Hides the "Sync is off" section (info box + 'Turn on syncing' button).
// Removing the policy hides no on/off controls.
add_task(async function test_sync_controls_reflect_feature_lock() {
  const restoreFxa = mockSignedInAccount();

  try {
    info("Enabled and Locked: the Disconnect control is hidden.");
    await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
      { policies: { Sync: { Enabled: true, Locked: true } } },
      null
    );
    // Enabling awaits connectSync before disallowFeature, so wait for the lock.
    await TestUtils.waitForCondition(
      () => !Services.policies.isAllowed(SYNC_FEATURE),
      "the sync feature is locked"
    );
    await checkDisconnect(true);

    info("Disabled and Locked: the 'Sync is off' controls are hidden.");
    await updatePolicies({
      policies: { Sync: { Enabled: false, Locked: true } },
    });
    // A prior connect means this may disconnect (async) before disallowFeature.
    await TestUtils.waitForCondition(
      () => !Services.policies.isAllowed(SYNC_FEATURE),
      "the sync feature is locked"
    );
    await checkTurnOn(true);

    info("Removed: the controls are shown again.");
    await updatePolicies({ policies: {} });
    checkSyncFeatureAllowed(true);
    await checkDisconnect(false);
    await checkTurnOn(false);
  } finally {
    restoreFxa();
    Services.prefs.clearUserPref("services.sync.username");
  }
});

// The synced tabs sidebar tool and the Firefox View "Tabs from other devices"
// nav follow the sync-tabs feature the Sync policy gates. Driving the states
// with live updates also proves the sidebar tool re-gates without a restart.
add_task(async function test_synced_tabs_visibility_follows_sync_policy() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  info("No policy: the synced tabs surfaces are visible.");
  checkSyncTabsFeatureAllowed(true);
  await checkSyncedTabsTool(false);
  await checkFirefoxViewSyncedTabsHidden(false);
  await checkHistoryMenuSyncedTabsHidden(false);

  // Omitting 'Enabled' is the only way to lock the tabs engine off while the
  // sync feature stays allowed, so it's the only case that gates on sync-tabs.
  info("Tabs engine locked off on its own: the synced tabs surfaces hide.");
  await updatePolicies({
    policies: { Sync: { Locked: true, OpenTabs: false } },
  });
  checkSyncTabsFeatureAllowed(false);
  checkSyncFeatureAllowed(true);
  await checkSyncedTabsTool(true);
  await checkFirefoxViewSyncedTabsHidden(true);
  await checkHistoryMenuSyncedTabsHidden(true);

  info("Sync disabled and locked: the synced tabs surfaces are hidden.");
  await updatePolicies({
    policies: { Sync: { Enabled: false, Locked: true } },
  });
  checkSyncTabsFeatureAllowed(false);
  await checkSyncedTabsTool(true);
  await checkFirefoxViewSyncedTabsHidden(true);
  await checkHistoryMenuSyncedTabsHidden(true);

  info("Tabs engine disabled and locked: the synced tabs surfaces are hidden.");
  await updatePolicies({
    policies: { Sync: { Enabled: true, Locked: true, OpenTabs: false } },
  });
  checkSyncTabsFeatureAllowed(false);
  await checkSyncedTabsTool(true);
  await checkFirefoxViewSyncedTabsHidden(true);
  await checkHistoryMenuSyncedTabsHidden(true);

  info("Sync locked on with tabs: the synced tabs surfaces stay visible.");
  await updatePolicies({
    policies: { Sync: { Enabled: true, Locked: true, OpenTabs: true } },
  });
  // Locking Sync on awaits connectSync before disallowing sync.
  await TestUtils.waitForCondition(
    () => !Services.policies.isAllowed(SYNC_FEATURE),
    "the sync feature is locked"
  );
  checkSyncTabsFeatureAllowed(true);
  await checkSyncedTabsTool(false);
  await checkFirefoxViewSyncedTabsHidden(false);
  // The History menu promo is the exception: locking sync on also locks the sync
  // feature, and the promo's only call to action here is to turn sync on.
  await checkHistoryMenuSyncedTabsHidden(true);

  info("Policy removed: the synced tabs surfaces are visible again.");
  await updatePolicies({ policies: {} });
  checkSyncTabsFeatureAllowed(true);
  await checkSyncedTabsTool(false);
  await checkFirefoxViewSyncedTabsHidden(false);
  await checkHistoryMenuSyncedTabsHidden(false);
});

// The Tools menu sync items (the native menubar on macOS) follow the sync
// feature gate, since the Sync policy leaves FxA enabled and gSync would
// otherwise show them (Bug 2061703). Re-gating needs no restart.
add_task(async function test_tools_menu_sync_items_follow_sync_policy() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const syncEnableItem = document.getElementById("sync-enable");

  info("No policy: the turn-on-sync item is shown.");
  gSync.updateState(SIGNED_IN_SYNC_OFF);
  ok(!syncEnableItem.hidden, "sync-enable is shown without a policy");

  info("Sync disabled and locked: the sync menu items are hidden.");
  await updatePolicies({
    policies: { Sync: { Enabled: false, Locked: true } },
  });
  await TestUtils.waitForCondition(
    () => !Services.policies.isAllowed(SYNC_FEATURE),
    "the sync feature is locked"
  );
  await withPinnedUIState(SIGNED_IN_SYNC_OFF, () =>
    fireMenuPopupCycle("menu_ToolsPopup", () => {
      ok(syncEnableItem.hidden, "sync-enable hides once the policy applies");
    })
  );

  info("A UIState update while locked keeps the items hidden.");
  gSync.updateState(SIGNED_IN_SYNC_OFF);
  ok(
    syncEnableItem.hidden,
    "sync-enable stays hidden while sync is disallowed"
  );

  // Only the menubar items are gated; the app menu's synced tabs views keep
  // following UIState, since the panel is reachable without the menubar.
  ok(
    !PanelMultiView.getViewNode(document, "PanelUI-remotetabs-syncdisabled")
      .hidden,
    "the synced tabs panel view is not gated on the policy"
  );

  info("Policy removed: the items follow UIState again.");
  await updatePolicies({ policies: {} });
  checkSyncFeatureAllowed(true);
  await withPinnedUIState(SIGNED_IN_SYNC_OFF, () =>
    fireMenuPopupCycle("menu_ToolsPopup", () => {
      ok(!syncEnableItem.hidden, "sync-enable is shown again without a policy");
    })
  );

  gSync.updateState(UIState.get());
});

// The menubar History and Bookmarks promos and both app menu sync promos all
// read gSync.getSyncPromoState(), so the gate lives there rather than on each
// surface. Its sign-in and turn-on-sync states are the ones the policy pins.
add_task(async function test_sync_promos_follow_sync_policy() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const oldGet = UIState.get;
  try {
    UIState.get = () => ({ status: UIState.STATUS_NOT_CONFIGURED });
    is(
      gSync.getSyncPromoState(),
      "signin",
      "Signed out offers the sign-in promo without a policy"
    );

    UIState.get = () => SIGNED_IN_SYNC_OFF;
    is(
      gSync.getSyncPromoState(),
      "turnonsync",
      "Sync off offers the turn-on-sync promo without a policy"
    );
    is(
      gSync.getSyncPromoState(["bookmarks"]),
      "turnonsync",
      "The bookmarks promo is offered without a policy"
    );
    await checkBookmarksMenuPromoHidden(false);

    await updatePolicies({
      policies: { Sync: { Enabled: false, Locked: true, Bookmarks: true } },
    });
    await TestUtils.waitForCondition(
      () => !Services.policies.isAllowed(SYNC_FEATURE),
      "the sync feature is locked"
    );

    UIState.get = () => ({ status: UIState.STATUS_NOT_CONFIGURED });
    is(
      gSync.getSyncPromoState(),
      null,
      "The sign-in promo is gone while the sync state is locked"
    );

    UIState.get = () => SIGNED_IN_SYNC_OFF;
    is(
      gSync.getSyncPromoState(),
      null,
      "The turn-on-sync promo is gone while the sync state is locked"
    );
    is(
      gSync.getSyncPromoState(["bookmarks"]),
      null,
      "The bookmarks promo is gone while the sync state is locked"
    );
    await checkBookmarksMenuPromoHidden(true);

    info("Policy removed: the promos come back.");
    await updatePolicies({ policies: {} });
    checkSyncFeatureAllowed(true);
    is(
      gSync.getSyncPromoState(),
      "turnonsync",
      "The turn-on-sync promo returns once the policy is removed"
    );
    await checkBookmarksMenuPromoHidden(false);

    info("Policy present but unlocked: the promos stay.");
    await updatePolicies({ policies: { Sync: { Enabled: false } } });
    checkSyncFeatureAllowed(true);
    await checkBookmarksMenuPromoHidden(false);
    await updatePolicies({ policies: {} });
  } finally {
    UIState.get = oldGet;
  }
});

// Locking sync ON disallows the sync feature too, but syncing now and repairing
// the account are not state changes, so those items have to survive the lock —
// the same line the settings sync section draws.
add_task(async function test_tools_menu_keeps_actions_when_sync_locked_on() {
  const restoreFxa = mockSignedInAccount();

  try {
    await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
      { policies: { Sync: { Enabled: true, Locked: true } } },
      null
    );
    // Enabling awaits connectSync before disallowFeature, so wait for the lock.
    await TestUtils.waitForCondition(
      () => !Services.policies.isAllowed(SYNC_FEATURE),
      "the sync feature is locked"
    );

    gSync.updateState(SIGNED_IN_SYNC_ON);
    ok(
      !document.getElementById("sync-syncnowitem").hidden,
      "sync-syncnowitem stays shown when the policy locks sync on"
    );

    gSync.updateState({ status: UIState.STATUS_LOGIN_FAILED });
    ok(
      !document.getElementById("sync-reauthitem").hidden,
      "sync-reauthitem stays shown so a locked-on sync can be repaired"
    );

    gSync.updateState({ status: UIState.STATUS_NOT_VERIFIED });
    ok(
      !document.getElementById("sync-unverifieditem").hidden,
      "sync-unverifieditem stays shown so the account can be verified"
    );

    gSync.updateState(SIGNED_IN_SYNC_OFF);
    ok(
      document.getElementById("sync-enable").hidden,
      "sync-enable is still gated, since turning sync on is a state change"
    );

    await updatePolicies({ policies: {} });
  } finally {
    restoreFxa();
    Services.prefs.clearUserPref("services.sync.username");
    gSync.updateState(UIState.get());
  }
});
