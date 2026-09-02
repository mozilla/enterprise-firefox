/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

// The newtab address bar takes the top layer only while its view is open, so
// that a modal dialog the page opens -- New Tab's settings pane -- paints over
// the closed bar. The top layer paints in the order elements enter it, which
// z-index cannot reorder.

"use strict";

const TEST_VALUE = "https://example.com/";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.suggest.searches", false]],
  });
});

add_task(async function topLayerFollowsTheView() {
  let tab = await NewtabSearchbarTestUtils.openNewTabPage();
  let browser = tab.linkedBrowser;

  Assert.ok(
    !(await NewtabSearchbarTestUtils.getState(browser)).popoverOpen,
    "a closed bar is ordinary page content"
  );

  await NewtabSearchbarTestUtils.promiseAutocompleteResultPopup({
    browser,
    value: TEST_VALUE,
  });
  let state = await NewtabSearchbarTestUtils.getState(browser);
  Assert.ok(state.viewVisible, "the view is painted");
  Assert.ok(state.popoverOpen, "an open bar is in the top layer");

  await NewtabSearchbarTestUtils.blur(browser);
  await NewtabSearchbarTestUtils.waitForViewClosed(browser);
  Assert.ok(
    !(await NewtabSearchbarTestUtils.getState(browser)).popoverOpen,
    "the bar gives the top layer back"
  );

  BrowserTestUtils.removeTab(tab);
});
