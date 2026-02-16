/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

async function resetTelemetry() {
  await Services.fog.testFlushAllChildren();
  Services.fog.testResetFOG();
}

async function tabIsInSplitView(tab) {
  const panel = document.getElementById(tab.linkedPanel);
  info("Waiting in tabIsInSplitView");
  await BrowserTestUtils.waitForMutationCondition(
    panel,
    { attributes: true },
    () => panel.classList.contains("split-view-panel")
  );
}

function navigateTab(tab, url) {
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, url);
  return BrowserTestUtils.browserLoaded(tab.linkedBrowser);
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.splitView.enabled", true]],
  });
});

registerCleanupFunction(async () => {
  await resetTelemetry();
});

add_task(async function test_splitview_uri_count_telemetry() {
  await resetTelemetry();
  // Create 4 tabs with different URLs
  const tabs = await Promise.all(
    [
      "https://example.com/start1",
      "https://example.com/start2",
      "https://example.org/start3",
      "about:blank",
    ].map(async url => {
      const tab = BrowserTestUtils.addTab(gBrowser, url);
      if (url !== "about:blank") {
        await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
      }
      return tab;
    })
  );
  await BrowserTestUtils.switchTab(gBrowser, tabs[0]);
  await Services.fog.testFlushAllChildren();

  // Verify telemetry starts undefined
  Assert.equal(
    Glean.splitview.uriCount["1"].testGetValue(),
    undefined,
    "URI count for left side (label '1') starts undefined"
  );
  Assert.equal(
    Glean.splitview.uriCount["2"].testGetValue(),
    undefined,
    "URI count for right side (label '2') starts undefined"
  );

  // Create split view (tab 0 is left/"1", tab 1 is right/"2")
  const splitView1 = gBrowser.addTabSplitView([tabs[0], tabs[1]], {
    id: 11,
  });
  await tabIsInSplitView(tabs[0]);
  await tabIsInSplitView(tabs[1]);
  Assert.ok(splitView1.splitViewId, "Split view created successfully");
  Assert.equal(splitView1.tabs.length, 2, "Split view has 2 tabs");

  await Services.fog.testFlushAllChildren();
  Assert.equal(
    Glean.splitview.uriCount["1"].testGetValue(),
    1,
    "URI count for left side (label '1') should be 1 after initial splitview creation"
  );
  Assert.equal(
    Glean.splitview.uriCount["2"].testGetValue(),
    1,
    "URI count for right side (label '2') should be 1 after initial splitview creation"
  );

  // Navigate the first (left-side) tab
  await navigateTab(tabs[0], "https://example.org/page1");
  await Services.fog.testFlushAllChildren();
  Assert.equal(
    Glean.splitview.uriCount["1"].testGetValue(),
    2,
    "URI count for left side (label '1') should increment to 2"
  );
  Assert.equal(
    Glean.splitview.uriCount["2"].testGetValue(),
    1,
    "URI count for right side should still be 1"
  );

  // Navigate the right-side tab
  await navigateTab(tabs[1], "https://example.com/page2");
  await Services.fog.testFlushAllChildren();
  Assert.equal(
    Glean.splitview.uriCount["1"].testGetValue(),
    2,
    "URI count for left side (label '1') should still be 2"
  );
  Assert.equal(
    Glean.splitview.uriCount["2"].testGetValue(),
    2,
    "URI count for right side (label '2') should increment to 2"
  );

  // Create a split view from the other 2 tabs
  info("Create a splitview from tabs 3 and 4");
  await BrowserTestUtils.switchTab(gBrowser, tabs[3]);
  const splitView2 = gBrowser.addTabSplitView([tabs[2], tabs[3]], {
    id: 21,
  });
  await tabIsInSplitView(tabs[2]);
  await tabIsInSplitView(tabs[3]);
  await Services.fog.testFlushAllChildren();

  Assert.equal(
    Glean.splitview.uriCount["1"].testGetValue(),
    3,
    "URI count for left side (label '1') should now be 3 after 2nd splitview creation"
  );
  Assert.equal(
    Glean.splitview.uriCount["2"].testGetValue(),
    2,
    "URI count for right side (label '2') should remain at 2 as only about:blank was loaded"
  );

  // Navigate the right-side tab in 2nd splitview
  await navigateTab(tabs[3], "https://example.com/page2");
  await Services.fog.testFlushAllChildren();
  Assert.equal(
    Glean.splitview.uriCount["1"].testGetValue(),
    3,
    "URI count for left side (label '1') should still be 3"
  );
  Assert.equal(
    Glean.splitview.uriCount["2"].testGetValue(),
    3,
    "URI count for right side (label '2') should increment to 3"
  );

  // Cleanup
  splitView1.close();
  splitView2.close();
  BrowserTestUtils.removeTab(tabs[0]);
  BrowserTestUtils.removeTab(tabs[1]);
  BrowserTestUtils.removeTab(tabs[2]);
  BrowserTestUtils.removeTab(tabs[3]);
});
