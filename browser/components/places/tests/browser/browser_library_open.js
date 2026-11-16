/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

/**
 * Test that bookmarks and history entries can be opened from the Library by
 * mouse double click.
 */
"use strict";

const PREF_LOAD_UI_LINK_IN_TAB = "browser.tabs.loadUILinkInTab";
const PREF_LOAD_UI_LINK_IN_BACKGROUND = "browser.tabs.loadUILinkInBackground";
const TEST_URL = "https://example.org/";

add_setup(async function () {
  await PlacesUtils.bookmarks.eraseEverything();
  await PlacesUtils.history.clear();
  await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.unfiledGuid,
    url: TEST_URL,
    title: TEST_URL,
  });
  await PlacesTestUtils.addVisits(TEST_URL);

  registerCleanupFunction(async () => {
    await PlacesUtils.bookmarks.eraseEverything();
    await PlacesUtils.history.clear();
  });
});

add_task(async function test_open_from_library() {
  // expected is where the link opens: "current", "foreground" or "background".
  const TEST_CASES = [
    {
      expected: "current",
    },
    {
      loadUILinkInBackground: true,
      expected: "current",
    },
    {
      loadUILinkInTab: true,
      expected: "foreground",
    },
    {
      loadUILinkInTab: true,
      loadUILinkInBackground: true,
      expected: "background",
    },
    {
      loadUILinkInTab: true,
      blankTab: true,
      expected: "current",
    },
  ];

  for (let target of ["bookmark", "history"]) {
    let isBookmark = target == "bookmark";
    let library = await promiseLibrary(
      isBookmark ? "UnfiledBookmarks" : "History"
    );

    for (let {
      loadUILinkInTab = false,
      loadUILinkInBackground = false,
      blankTab = false,
      expected,
    } of TEST_CASES) {
      await SpecialPowers.pushPrefEnv({
        set: [
          [PREF_LOAD_UI_LINK_IN_TAB, loadUILinkInTab],
          [PREF_LOAD_UI_LINK_IN_BACKGROUND, loadUILinkInBackground],
        ],
      });

      info(
        "Testing " +
          JSON.stringify({
            target,
            loadUILinkInTab,
            loadUILinkInBackground,
            blankTab,
            expected,
          })
      );
      await BrowserTestUtils.withNewTab(
        blankTab ? "about:blank" : "about:robots",
        async browser => {
          let tab = gBrowser.getTabForBrowser(browser);
          let onOpened =
            expected == "current"
              ? BrowserTestUtils.browserLoaded(browser, false, TEST_URL)
              : BrowserTestUtils.waitForNewTab(gBrowser, TEST_URL);

          await doubleClickInLibrary(library, isBookmark);

          let newTab = await onOpened;
          if (expected != "current") {
            Assert.equal(
              gBrowser.selectedTab == tab,
              expected == "background",
              `The new tab is in the ${expected}`
            );
            BrowserTestUtils.removeTab(newTab);
          }
        }
      );

      await SpecialPowers.popPrefEnv();
    }

    await promiseLibraryClosed(library);
  }
});

async function doubleClickInLibrary(library, isBookmark) {
  let tree = library.ContentTree.view;
  let node;
  for (let i = 0; i < tree.view.rowCount; i++) {
    if (tree.view.nodeForTreeIndex(i).uri == TEST_URL) {
      node = tree.view.nodeForTreeIndex(i);
      break;
    }
  }
  Assert.ok(node && PlacesUtils.nodeIsBookmark(node) == isBookmark);
  tree.selectNode(node);
  await synthesizeClickOnSelectedTreeCell(tree, { clickCount: 2 });
}
