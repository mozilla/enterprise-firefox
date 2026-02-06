/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.splitView.enabled", true]],
  });
});

registerCleanupFunction(async function () {
  await SpecialPowers.popPrefEnv();
});

add_task(async function () {
  const tab1 = await addTab();
  const tab2 = await addTab();
  gBrowser.addTabSplitView([tab1, tab2]);

  let delayedStartupPromise = BrowserTestUtils.waitForNewWindow();
  let win = gBrowser.replaceTabsWithWindow(tab1);
  await delayedStartupPromise;

  ok(
    win.gBrowser.tabs[0].splitview,
    "Splitview has been moved to a new window"
  );

  await BrowserTestUtils.closeWindow(win);
});
