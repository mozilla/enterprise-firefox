/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Test that bookmarks and history entries can be opened from the Bookmarks
 * and History menus.
 */
"use strict";

ChromeUtils.defineESModuleGetters(this, {
  PlacesTestUtils: "resource://testing-common/PlacesTestUtils.sys.mjs",
});

const TEST_URL = "https://example.org/";

add_setup(async function () {
  await PlacesUtils.bookmarks.eraseEverything();
  await PlacesUtils.history.clear();
  await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.menuGuid,
    url: TEST_URL,
    title: TEST_URL,
  });
  await PlacesTestUtils.addVisits(TEST_URL);

  registerCleanupFunction(async () => {
    await PlacesUtils.bookmarks.eraseEverything();
    await PlacesUtils.history.clear();
  });
});

add_task(async function test_open_from_menus() {
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
    {
      accelKey: true,
      expected: "foreground",
    },
    {
      accelKey: true,
      loadUILinkInBackground: true,
      expected: "background",
    },
    {
      accelKey: true,
      loadUILinkInTab: true,
      expected: "foreground",
    },
    {
      accelKey: true,
      loadUILinkInTab: true,
      loadUILinkInBackground: true,
      expected: "background",
    },
    {
      accelKey: true,
      loadUILinkInTab: true,
      blankTab: true,
      expected: "current",
    },
  ];

  for (let target of ["bookmark", "history"]) {
    for (let {
      loadUILinkInTab = false,
      loadUILinkInBackground = false,
      blankTab = false,
      accelKey = false,
      expected,
    } of TEST_CASES) {
      await SpecialPowers.pushPrefEnv({
        set: [
          ["browser.tabs.loadUILinkInTab", loadUILinkInTab],
          ["browser.tabs.loadUILinkInBackground", loadUILinkInBackground],
        ],
      });

      info(
        "Testing " +
          JSON.stringify({
            target,
            loadUILinkInTab,
            loadUILinkInBackground,
            blankTab,
            accelKey,
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

          if (target == "bookmark") {
            await clickOnMenuItem("bookmarksMenuPopup", true, accelKey);
          } else {
            await clickOnMenuItem("historyMenuPopup", false, accelKey);
          }

          let newTab = await onOpened;
          if (expected != "current") {
            Assert.equal(gBrowser.selectedTab == tab, expected == "background");
            BrowserTestUtils.removeTab(newTab);
          }
        }
      );

      await SpecialPowers.popPrefEnv();
    }
  }
});

async function clickOnMenuItem(popupId, isBookmark, accelKey) {
  let popup = document.getElementById(popupId);
  await simulateMenuOpen(popup);
  let item = [...popup.children].find(
    node => node._placesNode?.uri == TEST_URL
  );
  Assert.ok(item && PlacesUtils.nodeIsBookmark(item._placesNode) == isBookmark);
  let isMac = AppConstants.platform == "macosx";
  let event = document.createEvent("XULCommandEvent");
  event.initCommandEvent(
    "command",
    true,
    true,
    window,
    0,
    accelKey && !isMac,
    false,
    false,
    accelKey && isMac
  );
  item.dispatchEvent(event);
  await simulateMenuClosed(popup);
}
