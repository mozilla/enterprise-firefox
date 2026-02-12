/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

let currentReduceMotionOverride;

add_setup(() => {
  currentReduceMotionOverride = gReduceMotionOverride;
  // Disable tab animations
  gReduceMotionOverride = true;
});

add_task(async function test_drag_splitview_tab() {
  let [tab1, tab2, tab3] = await Promise.all(
    Array.from({ length: 3 }).map((_, index) =>
      addTab(`data:text/plain,tab${index + 1}`)
    )
  );

  const startingTab = gBrowser.tabs[0];
  let splitview = gBrowser.addTabSplitView([tab2, tab3]);
  Assert.equal(splitview.tabs.length, 2, "Split view has 2 tabs");

  Assert.deepEqual(
    gBrowser.tabs,
    [startingTab, tab1, tab2, tab3],
    "confirm tabs' starting order"
  );
  try {
    info("Drag a splitview tab");
    await customDragAndDrop(tab3, tab1, null, waitForTabMove(tab3));

    Assert.deepEqual(
      gBrowser.tabs,
      [startingTab, tab2, tab3, tab1],
      "Confirm that tab3 and tab2 in a splitview move together before tab1"
    );

    info("Drag a tab in between a splitview");
    await customDragAndDrop(tab1, tab2, null, waitForTabMove(tab1));

    Assert.deepEqual(
      gBrowser.tabs,
      [startingTab, tab1, tab2, tab3],
      "Confirm that tab1 cannot be dragged in between splitview tabs"
    );

    let group = gBrowser.addTabGroup([tab1, splitview]);
    Assert.equal(group.tabs.length, 3, "group has 3 tabs");

    Assert.deepEqual(
      gBrowser.tabs,
      [startingTab, tab1, tab2, tab3],
      "Confirm that splitview tabs can be reordered within a tab group"
    );
    // ensure we drag before tab 1, not after
    let event = getDragEvent();
    info("Drag splitview tabs within a tab group");
    await customDragAndDrop(tab2, tab1, null, null, event);

    Assert.deepEqual(
      gBrowser.tabs,
      [startingTab, tab2, tab3, tab1],
      "Confirm that splitview tabs can be reordered within a tab group"
    );
  } finally {
    BrowserTestUtils.removeTab(tab1);
    BrowserTestUtils.removeTab(tab2);
    BrowserTestUtils.removeTab(tab3);
  }
});

add_task(async function test_dragging_splitview_second_window() {
  let win2 = await BrowserTestUtils.openNewBrowserWindow();
  let [tab1, tab2] = await Promise.all(
    Array.from({ length: 2 }).map((_, index) =>
      addTab(`data:text/plain,tab${index + 1}`)
    )
  );

  let splitview = window.gBrowser.addTabSplitView([tab1, tab2]);
  Assert.equal(splitview.tabs.length, 2, "Split view has 2 tabs");

  let secondWindowTab1 = win2.gBrowser.tabs[0];
  let secondWindowTab2 = BrowserTestUtils.addTab(
    win2.gBrowser,
    "data:text/plain,tab4"
  );

  is(win2.gBrowser.tabs.length, 2, "win2 contains 2 tabs");

  let awaitCloseEvent = BrowserTestUtils.waitForEvent(tab1, "TabClose");
  let awaitOpenEvent = BrowserTestUtils.waitForEvent(win2, "TabOpen");

  let effect = EventUtils.synthesizeDrop(
    tab1,
    secondWindowTab1,
    [[{ type: TAB_DROP_TYPE, data: tab1 }]],
    null,
    window,
    win2
  );
  is(effect, "move", "Tabs should be moved from win1 to win2.");

  let closeEvent = await awaitCloseEvent;
  let openEvent = await awaitOpenEvent;

  is(openEvent.detail.adoptedTab, tab1, "New tab adopted old tab");

  is(
    closeEvent.detail.adoptedBy,
    openEvent.target,
    "Old tab adopted by new tab"
  );

  is(
    win2.gBrowser.tabs.length,
    4,
    "win2 contains 2 new tabs, for a total of 4"
  );

  let [secondWindowTab3, secondWindowTab4] = win2.gBrowser.tabs.slice(1, 3);

  Assert.deepEqual(
    win2.gBrowser.tabs,
    [secondWindowTab1, secondWindowTab3, secondWindowTab4, secondWindowTab2],
    "Two new tabs were inserted in the correct position in the second window"
  );

  ok(
    secondWindowTab3.splitview && secondWindowTab4.splitview,
    "Two new tabs in second window are splitview tabs"
  );

  await BrowserTestUtils.closeWindow(win2);
});

add_task(async function test_drag_link_before_or_after_splitview_tabs() {
  // Setup: [Tab1, (Tab2, Tab3), Tab4]
  const tab1 = gBrowser.tabs[0];
  const tab2 = await addTab("data:text/plain,tab2");
  const tab3 = await addTab("data:text/plain,tab3");
  gBrowser.addTabSplitView([tab2, tab3]);
  const tab4 = await addTab("data:text/plain,tab4");
  Assert.deepEqual(
    gBrowser.tabs,
    [tab1, tab2, tab3, tab4],
    "confirm tabs' starting order"
  );

  // Create a draggable link
  let linkEl = document.createXULElement("label");
  linkEl.setAttribute("value", "Draggable Link");
  linkEl.setAttribute("draggable", "true");
  document.documentElement.appendChild(linkEl);

  info("Drag and drop the link before the Split View.");
  const url = "https://example.com/";
  let rect = tab2.getBoundingClientRect();
  let promiseTabOpen = BrowserTestUtils.waitForEvent(window, "TabOpen");
  EventUtils.synthesizeDrop(
    linkEl,
    tab2,
    [[{ type: "text/uri-list", data: url }]],
    "link",
    window,
    window,
    {
      clientX: rect.left + 10,
      clientY: rect.top + rect.height / 2,
    }
  );
  await promiseTabOpen;

  // Verify Result: [Tab1, NEW, (Tab2, Tab3), Tab4]
  Assert.equal(gBrowser.tabs.length, 5, "Should have 5 tabs after drop.");
  let newTab = gBrowser.tabs[1];
  await BrowserTestUtils.browserLoaded(newTab.linkedBrowser, { wantLoad: url });
  Assert.ok(!newTab.splitview, "New tab is not part of the split view.");
  Assert.deepEqual(
    gBrowser.tabs,
    [tab1, newTab, tab2, tab3, tab4],
    "Order should be [A, New, B, C, D]"
  );
  BrowserTestUtils.removeTab(newTab);

  info("Drag and drop the link after the Split View.");
  rect = tab3.getBoundingClientRect();
  promiseTabOpen = BrowserTestUtils.waitForEvent(window, "TabOpen");
  EventUtils.synthesizeDrop(
    linkEl,
    tab3,
    [[{ type: "text/uri-list", data: url }]],
    "link",
    window,
    window,
    {
      clientX: rect.right - 10,
      clientY: rect.top + rect.height / 2,
    }
  );
  await promiseTabOpen;

  // Verify Result: [Tab1, (Tab2, Tab3), NEW, Tab4]
  Assert.equal(gBrowser.tabs.length, 5, "Should have 5 tabs after drop.");
  newTab = gBrowser.tabs[3];
  await BrowserTestUtils.browserLoaded(newTab.linkedBrowser, { wantLoad: url });
  Assert.ok(!newTab.splitview, "New tab is not part of the split view.");
  Assert.deepEqual(
    gBrowser.tabs,
    [tab1, tab2, tab3, newTab, tab4],
    "Order should be [A, B, C, New, D]"
  );
  BrowserTestUtils.removeTab(newTab);

  info("Drag and drop the link within the margins of the Split View wrapper.");
  const splitViewBox = tab2.splitview.getBoundingClientRect();
  promiseTabOpen = BrowserTestUtils.waitForEvent(window, "TabOpen");
  EventUtils.synthesizeDrop(
    linkEl,
    gBrowser.tabContainer.arrowScrollbox,
    [[{ type: "text/uri-list", data: url }]],
    "link",
    window,
    window,
    {
      clientX: splitViewBox.left + splitViewBox.width * 0.75,
      clientY: splitViewBox.bottom + 1,
    }
  );
  await promiseTabOpen;

  // Verify Result: [Tab1, (Tab2, Tab3), NEW, Tab4]
  Assert.equal(gBrowser.tabs.length, 5, "Should have 5 tabs after drop.");
  newTab = gBrowser.tabs[3];
  await BrowserTestUtils.browserLoaded(newTab.linkedBrowser, { wantLoad: url });
  Assert.ok(!newTab.splitview, "New tab is not part of the split view.");
  Assert.deepEqual(
    gBrowser.tabs,
    [tab1, tab2, tab3, newTab, tab4],
    "Order should be [A, B, C, New, D]"
  );
  BrowserTestUtils.removeTab(newTab);

  // Cleanup
  BrowserTestUtils.removeTab(tab2);
  BrowserTestUtils.removeTab(tab3);
  BrowserTestUtils.removeTab(tab4);
  linkEl.remove();
});
