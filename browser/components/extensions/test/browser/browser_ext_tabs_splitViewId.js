/* -*- Mode: indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set sts=2 sw=2 et tw=80: */
"use strict";

function getRealTabByExtensionTabId(tabId) {
  const {
    Management: {
      global: { tabTracker },
    },
  } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
  return tabTracker.getTab(tabId);
}

function loadExtensionForSplitViewTest({ background }) {
  async function createSplit(tabIds) {
    return new Promise(resolve => {
      browser.test.onMessage.addListener(function l(msg, splitViewId) {
        browser.test.assertEq("createSplit:done", msg, "createSplit done");
        browser.test.onMessage.removeListener(l);
        resolve(splitViewId);
      });
      browser.test.sendMessage("createSplit", tabIds);
    });
  }
  const extension = ExtensionTestUtils.loadExtension({
    background: `(${background})(${createSplit})`,
  });
  extension.onMessage("createSplit", tabIds => {
    const tab1 = getRealTabByExtensionTabId(tabIds[0]);
    const tab2 = getRealTabByExtensionTabId(tabIds[1]);
    const splitview = tab1.ownerGlobal.gBrowser.addTabSplitView([tab1, tab2], {
      insertBefore: tab1,
    });
    extension.sendMessage("createSplit:done", splitview.splitViewId);
  });
  return extension;
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.splitView.enabled", true]],
  });
});

add_task(async function test_existing_adjacent_tabs_in_splitview() {
  let extension = loadExtensionForSplitViewTest({
    background: async createSplit => {
      const { id: windowId } = await browser.windows.create({});
      // tabId0 not declared; the first tab exists so we can test its existence
      // via tabs.query(), but we do not do anything else with it.
      const { id: tabId1 } = await browser.tabs.create({ windowId });
      const { id: tabId2 } = await browser.tabs.create({ windowId });

      browser.tabs.onMoved.addListener((movedTabId, moveInfo) => {
        // We are going to wrap existing tabs in a split view. Their indexes do
        // not change, so we are not expecting a tabs.onMoved event.
        browser.test.fail(
          `Unexpected tabs.onMoved: ${movedTabId}, ${JSON.stringify(moveInfo)}`
        );
      });
      const changes = [];
      browser.tabs.onUpdated.addListener(
        (tabId, changeInfo) => {
          changes.push({ tabId, changeInfo });
        },
        { properties: ["splitViewId"] }
      );

      const splitViewId = await createSplit([tabId1, tabId2]);
      browser.test.assertTrue(
        Number.isSafeInteger(splitViewId) && splitViewId > 0,
        `Created split view and got integer ID: ${splitViewId}`
      );

      browser.test.assertDeepEq(
        [-1, splitViewId, splitViewId],
        (await browser.tabs.query({ windowId })).map(t => t.splitViewId),
        "splitViewId values after creating split of adjacent tabs"
      );

      // After creating the split, and doing a roundtrip to the parent, we
      // should have received all tabs.onUpdated related to the split view
      // creation. Verify the observed events:
      browser.test.assertDeepEq(
        [
          { tabId: tabId1, changeInfo: { splitViewId } },
          { tabId: tabId2, changeInfo: { splitViewId } },
        ],
        changes.splice(0),
        "Got expected tabs.onUpdated events after creating split"
      );

      // Removing a tab would leave one tab remaining, which cannot happen
      // because a split contains two tabs. The split should therefore unsplit.
      await browser.tabs.remove(tabId2);
      browser.test.assertEq(
        -1,
        (await browser.tabs.get(tabId1)).splitViewId,
        "When the other tab in the split closes, the first tab unsplits"
      );
      browser.test.assertDeepEq(
        [{ tabId: tabId1, changeInfo: { splitViewId: -1 } }],
        changes.splice(0),
        "Got expected tabs.onUpdated events after unsplit"
      );

      await browser.windows.remove(windowId);
      browser.test.sendMessage("done");
    },
  });
  await extension.startup();
  await extension.awaitMessage("done");
  await extension.unload();
});

// Tests what happens when we use tabs.move() to move a tab into an existing
// split view. Because a split view can contain only two tabs, it is not
// possible for the tab to end up at the specified position AND for it to enter
// the existing split. The result is therefore to move the tab to the left of
// the split. This behavior differs from Chrome (bug 2016751).
add_task(async function test_move_another_tab_into_splitview() {
  let extension = loadExtensionForSplitViewTest({
    background: async createSplit => {
      const { id: windowId, tabs } = await browser.windows.create({});
      const { id: tabId0 } = tabs[0];
      const { id: tabId1 } = await browser.tabs.create({ windowId });
      const { id: tabId2 } = await browser.tabs.create({ windowId });
      const { id: tabId3 } = await browser.tabs.create({ windowId });
      const { id: tabId4 } = await browser.tabs.create({ windowId });

      const changes = [];
      browser.tabs.onMoved.addListener((movedTabId, moveInfo) => {
        changes.push({ movedTabId, moveInfo });
      });
      browser.tabs.onUpdated.addListener(
        (tabId, changeInfo) => {
          changes.push({ tabId, changeInfo });
        },
        { properties: ["splitViewId"] }
      );

      const splitViewId = await createSplit([tabId1, tabId2]);

      // Move tab from the right of split "into" the split.
      const [movedTab] = await browser.tabs.move(tabId3, { index: 2 });
      browser.test.assertEq(-1, movedTab.splitViewId, "Cannot move into split");
      browser.test.assertEq(1, movedTab.index, "Appears at left of split");
      browser.test.assertDeepEq(
        [
          { index: 0, tabId: tabId0, splitViewId: -1 },
          { index: 1, tabId: tabId3, splitViewId: -1 }, // Moved from index 3.
          { index: 2, tabId: tabId1, splitViewId },
          { index: 3, tabId: tabId2, splitViewId },
          { index: 4, tabId: tabId4, splitViewId: -1 },
        ],
        Array.from(await browser.tabs.query({ windowId }), t => ({
          index: t.index,
          tabId: t.id,
          splitViewId: t.splitViewId,
        })),
        // Apparently, we expect to push the tab to the left of a split view
        // when we attempt to move a tab to to a position between split views.
        // This behavior differs from Chrome (bug 2016751).
        "Result of attempt to move a tab (from right) between tabs in split view"
      );
      browser.test.assertDeepEq(
        [
          { tabId: tabId1, changeInfo: { splitViewId } },
          { tabId: tabId2, changeInfo: { splitViewId } },
          {
            movedTabId: tabId3,
            moveInfo: { windowId, fromIndex: 3, toIndex: 1 },
          },
        ],
        changes.splice(0),
        "Got expected tabs events after moving tab to new split"
      );

      // Move tab from the left of split "into" the split.
      await browser.tabs.move(tabId0, { index: 2 });
      browser.test.assertDeepEq(
        [
          { index: 0, tabId: tabId3, splitViewId: -1 },
          { index: 1, tabId: tabId1, splitViewId },
          { index: 2, tabId: tabId2, splitViewId },
          { index: 3, tabId: tabId0, splitViewId: -1 }, // Moved from index 0.
          { index: 4, tabId: tabId4, splitViewId: -1 },
        ],
        Array.from(await browser.tabs.query({ windowId }), t => ({
          index: t.index,
          tabId: t.id,
          splitViewId: t.splitViewId,
        })),
        // Apparently, we expect to push the tab to the right of a split view
        // when we attempt to move a tab to to a position between split views.
        // This behavior differs from Chrome (bug 2016751).
        "Result of attempt to move a tab (from left) between tabs in split view"
      );
      browser.test.assertDeepEq(
        [
          {
            movedTabId: tabId0,
            moveInfo: { windowId, fromIndex: 0, toIndex: 3 },
          },
        ],
        changes.splice(0),
        "Got expected tabs events after moving tab to new split"
      );

      await browser.windows.remove(windowId);
      browser.test.sendMessage("done");
    },
  });
  await extension.startup();
  await extension.awaitMessage("done");
  await extension.unload();
});
