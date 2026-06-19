/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

async function openAllTabsMenu(win = window) {
  const allTabsView = win.document.getElementById("allTabsMenu-allTabsView");
  const shown = BrowserTestUtils.waitForEvent(allTabsView, "ViewShown");
  win.document.getElementById("alltabs-button").click();
  await shown;
  return allTabsView;
}

async function closeAllTabsMenu(win = window) {
  const panel = win.document
    .getElementById("allTabsMenu-allTabsView")
    .closest("panel");
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await hidden;
}

// The "New Container Tab" and "Close Duplicate Tabs" items live inside the
// scrollable tab list as its first two children, so they scroll with the tabs
add_task(async function test_menu_item_order_and_visibility() {
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.userContext.enabled", true]],
  });

  // Create duplicate tabs so "Close Duplicate Tabs" is shown
  const tabA = await addTab("https://example.com/duplicate");
  const tabB = await addTab("https://example.com/duplicate");

  window.gTabsPanel.init();
  await openAllTabsMenu();

  const tabsList = document.getElementById("allTabsMenu-allTabsView-tabs");
  const containerButton = document.getElementById(
    "allTabsMenu-containerTabsButton"
  );
  const closeDuplicateButton = document.getElementById(
    "allTabsMenu-closeDuplicateTabs"
  );

  is(
    tabsList.children[0],
    containerButton,
    "New Container Tab is the first item in the tab list"
  );
  is(
    tabsList.children[1],
    closeDuplicateButton,
    "Close Duplicate Tabs is the second item in the tab list"
  );
  ok(
    BrowserTestUtils.isVisible(containerButton),
    "New Container Tab is visible when containers are enabled"
  );
  ok(
    BrowserTestUtils.isVisible(closeDuplicateButton),
    "Close Duplicate Tabs is visible when duplicate tabs exist"
  );

  const firstTabRow = tabsList.querySelector(".all-tabs-item");
  is(
    tabsList.children[2],
    firstTabRow,
    "The first tab is the third item in the list, after the two action buttons"
  );

  await closeAllTabsMenu();
  BrowserTestUtils.removeTab(tabA);
  BrowserTestUtils.removeTab(tabB);
  await SpecialPowers.popPrefEnv();
});

// "Close Duplicate Tabs" is hidden, not disabled, when there are no
// duplicate tabs
add_task(async function test_close_duplicate_hidden_without_duplicates() {
  window.gTabsPanel.init();
  await openAllTabsMenu();

  const tabsList = document.getElementById("allTabsMenu-allTabsView-tabs");
  const closeDuplicateButton = document.getElementById(
    "allTabsMenu-closeDuplicateTabs"
  );

  ok(
    closeDuplicateButton.hidden,
    "Close Duplicate Tabs is hidden when there are no duplicate tabs"
  );
  is(
    tabsList.children[1],
    closeDuplicateButton,
    "Close Duplicate Tabs keeps its position while hidden"
  );

  await closeAllTabsMenu();
});

// When there are hidden tabs but none are playing audio, the "Hidden Tabs"
// button is an ordinary item at the end of the scrollable tab list
add_task(async function test_hidden_tabs_button_at_bottom() {
  const hiddenTab = await addTab("about:blank");
  const tabHidden = BrowserTestUtils.waitForEvent(hiddenTab, "TabHide");
  gBrowser.hideTab(hiddenTab);
  await tabHidden;

  window.gTabsPanel.init();
  await openAllTabsMenu();

  const tabsList = document.getElementById("allTabsMenu-allTabsView-tabs");
  const hiddenTabsButton = document.getElementById(
    "allTabsMenu-hiddenTabsButton"
  );
  const hiddenTabsSeparator = document.getElementById(
    "allTabsMenu-hiddenTabsSeparator"
  );

  ok(
    BrowserTestUtils.isVisible(hiddenTabsButton),
    "Hidden Tabs button is visible when hidden tabs exist"
  );
  ok(
    hiddenTabsSeparator.hidden,
    "Hidden Tabs separator is hidden when no hidden tabs are playing audio"
  );
  is(
    hiddenTabsButton.parentNode,
    tabsList,
    "Hidden Tabs button is inside the scrollable tab list"
  );
  const lastTabRow = [...tabsList.querySelectorAll(".all-tabs-item")].at(-1);
  is(
    lastTabRow.nextElementSibling,
    hiddenTabsButton,
    "Hidden Tabs button immediately follows the last visible tab row, no separator"
  );

  await closeAllTabsMenu();
  gBrowser.showTab(hiddenTab);
  BrowserTestUtils.removeTab(hiddenTab);
});

// When a hidden tab is playing audio, it sits at the top of the current window
// section. The "Hidden Tabs" button and the tab playing audio appear before the
// visible tabs.
add_task(async function test_hidden_audio_tabs_at_top() {
  const hiddenTab = await addTab("about:blank");
  const tabHidden = BrowserTestUtils.waitForEvent(hiddenTab, "TabHide");
  gBrowser.hideTab(hiddenTab);
  await tabHidden;
  hiddenTab.setAttribute("soundplaying", "");

  window.gTabsPanel.init();
  await openAllTabsMenu();

  const currentWindowHeader = document.getElementById(
    "allTabsMenu-currentWindowHeader"
  );
  const hiddenTabsButton = document.getElementById(
    "allTabsMenu-hiddenTabsButton"
  );
  const hiddenAudioTabs = document.getElementById(
    "allTabsMenu-allTabsView-hiddenAudio-tabs"
  );
  const hiddenTabsSeparator = document.getElementById(
    "allTabsMenu-hiddenTabsSeparator"
  );
  const tabsList = document.getElementById("allTabsMenu-allTabsView-tabs");

  ok(
    BrowserTestUtils.isVisible(hiddenTabsButton),
    "Hidden Tabs button is visible"
  );
  ok(
    BrowserTestUtils.isVisible(hiddenAudioTabs),
    "Hidden audio tabs container is visible"
  );
  is(
    currentWindowHeader.nextElementSibling,
    hiddenTabsButton,
    "Hidden Tabs button is immediately after the current window header"
  );
  is(
    hiddenTabsButton.nextElementSibling,
    hiddenAudioTabs,
    "Audio tabs container follows the Hidden Tabs button"
  );
  is(
    hiddenAudioTabs.nextElementSibling,
    hiddenTabsSeparator,
    "Separator follows the audio tabs container"
  );
  ok(
    hiddenTabsSeparator.compareDocumentPosition(tabsList) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    "Visible tabs list comes after the separator"
  );

  info("Muted tabs should stay in the audio-playing list");
  hiddenTab.removeAttribute("soundplaying");
  hiddenTab.setAttribute("muted", "");
  hiddenTab.dispatchEvent(
    new CustomEvent("TabAttrModified", {
      bubbles: true,
      detail: { changed: ["muted", "soundplaying"] },
    })
  );

  ok(!hiddenTab.soundPlaying, "Tab is no longer playing audio after muting");
  const mutedRow = [...hiddenAudioTabs.querySelectorAll(".all-tabs-item")].find(
    r => r._tab == hiddenTab
  );
  ok(mutedRow, "Muted hidden tab stays in the audio-playing list");

  await closeAllTabsMenu();
  hiddenTab.removeAttribute("muted");
  gBrowser.showTab(hiddenTab);
  BrowserTestUtils.removeTab(hiddenTab);
});

// Adding a tab while the menu is open re-renders the tab list. The two action
// buttons must remain its first two children.
add_task(async function test_buttons_persist_after_tab_added() {
  window.gTabsPanel.init();
  await openAllTabsMenu();

  const tabsList = document.getElementById("allTabsMenu-allTabsView-tabs");
  const containerButton = document.getElementById(
    "allTabsMenu-containerTabsButton"
  );
  const closeDuplicateButton = document.getElementById(
    "allTabsMenu-closeDuplicateTabs"
  );

  const newTab = await addTab("https://example.com/persist");
  await TestUtils.waitForCondition(
    () =>
      [...tabsList.querySelectorAll(".all-tabs-item")].some(
        row => row._tab == newTab
      ),
    "the newly added tab has a row in the list"
  );

  is(
    tabsList.children[0],
    containerButton,
    "New Container Tab is still the first item after a tab is added"
  );
  is(
    tabsList.children[1],
    closeDuplicateButton,
    "Close Duplicate Tabs is still the second item after a tab is added"
  );

  await closeAllTabsMenu();
  BrowserTestUtils.removeTab(newTab);
});
