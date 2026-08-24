/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { require } = ChromeUtils.importESModule(
  "resource://devtools/shared/loader/Loader.sys.mjs"
);
const {
  gDevTools,
} = require("resource://devtools/client/framework/devtools.js");

const DEVTOOLS_DISABLED_PREF = "devtools.policy.disabled";

// Tools-menu items whose visibility is driven by the policy.
const POLICY_MENU_ITEM_IDS = [
  "menu_devToolbox",
  "menu_browserConsole",
  "menu_responsiveUI",
  "menu_eyedropper",
];

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(DEVTOOLS_DISABLED_PREF);
});

function synthesizeToggleToolboxKey() {
  if (Services.appinfo.OS == "Darwin") {
    EventUtils.synthesizeKey("i", { accelKey: true, altKey: true });
  } else {
    EventUtils.synthesizeKey("i", { accelKey: true, shiftKey: true });
  }
}

async function openToolboxViaShortcut(tab) {
  gBrowser.selectedTab = tab;
  const onReady = gDevTools.once("toolbox-ready");
  synthesizeToggleToolboxKey();
  await onReady;
  return gDevTools.getToolboxForTab(tab);
}

function checkKeyShortcuts(available) {
  is(
    !!document.getElementById("devtoolsKeyset"),
    available,
    `DevTools key shortcuts are ${available ? "present" : "removed"}`
  );
}

function checkMenuItems(available) {
  for (const id of POLICY_MENU_ITEM_IDS) {
    is(
      document.getElementById(id).hidden,
      !available,
      `${id} is ${available ? "visible" : "hidden"}`
    );
  }
}

// Open the content context menu and assert whether "Inspect Element" is shown.
async function checkInspectContextItem(browser, available) {
  const contextMenu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForEvent(contextMenu, "popupshown");
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "body",
    { type: "contextmenu" },
    browser
  );
  await shown;

  is(
    document.getElementById("context-inspect").hidden,
    !available,
    `"Inspect Element" context-menu item is ${available ? "visible" : "hidden"}`
  );

  const hidden = BrowserTestUtils.waitForEvent(contextMenu, "popuphidden");
  contextMenu.hidePopup();
  await hidden;
}

// 1. gDevTools.showToolbox is the open-path backstop: it refuses to open a
// toolbox while disabled, and opens normally otherwise.
add_task(async function test_showToolbox_respects_policy() {
  await BrowserTestUtils.withNewTab(
    "data:text/html,<title>showToolbox</title>",
    async browser => {
      const tab = gBrowser.getTabForBrowser(browser);

      const toolbox = await gDevTools.showToolboxForTab(tab);
      ok(toolbox, "showToolboxForTab opens a toolbox while enabled");
      await toolbox.destroy();

      Services.prefs.setBoolPref(DEVTOOLS_DISABLED_PREF, true);
      is(
        await gDevTools.showToolboxForTab(tab),
        null,
        "showToolboxForTab is refused while disabled"
      );
      is(gDevTools.getToolboxForTab(tab), null, "No toolbox was opened");

      Services.prefs.clearUserPref(DEVTOOLS_DISABLED_PREF);
      const reopened = await gDevTools.showToolboxForTab(tab);
      ok(reopened, "showToolboxForTab opens again once re-enabled");
      await reopened.destroy();
    }
  );
});

// 2. The DevTools key shortcuts (the whole keyset) follow the policy live.
add_task(async function test_key_shortcuts_respect_policy() {
  checkKeyShortcuts(true);

  Services.prefs.setBoolPref(DEVTOOLS_DISABLED_PREF, true);
  checkKeyShortcuts(false);

  Services.prefs.setBoolPref(DEVTOOLS_DISABLED_PREF, false);
  checkKeyShortcuts(true);

  Services.prefs.clearUserPref(DEVTOOLS_DISABLED_PREF);
});

// 3. The Tools-menu items follow the policy live.
add_task(async function test_menu_items_respect_policy() {
  await BrowserTestUtils.withNewTab(
    "data:text/html,<title>menu items</title>",
    async browser => {
      const tab = gBrowser.getTabForBrowser(browser);
      // Load devtools-browser so the Tools-menu items are created.
      const toolbox = await openToolboxViaShortcut(tab);
      await toolbox.destroy();

      checkMenuItems(true);

      Services.prefs.setBoolPref(DEVTOOLS_DISABLED_PREF, true);
      checkMenuItems(false);

      Services.prefs.setBoolPref(DEVTOOLS_DISABLED_PREF, false);
      checkMenuItems(true);

      Services.prefs.clearUserPref(DEVTOOLS_DISABLED_PREF);
    }
  );
});

// 4. An open in-window toolbox is closed when DevTools are disabled live.
add_task(async function test_in_window_toolbox_closes_on_disable() {
  await BrowserTestUtils.withNewTab(
    "data:text/html,<title>in-window toolbox live</title>",
    async browser => {
      const tab = gBrowser.getTabForBrowser(browser);

      const toolbox = await openToolboxViaShortcut(tab);
      ok(toolbox, "Toolbox opened via the shortcut");

      Services.prefs.setBoolPref(DEVTOOLS_DISABLED_PREF, true);
      await TestUtils.waitForCondition(
        () => !gDevTools.getToolboxForTab(tab),
        "The open toolbox is closed when DevTools are disabled live"
      );

      Services.prefs.clearUserPref(DEVTOOLS_DISABLED_PREF);
    }
  );
});

// 5. The "Inspect Element" content context-menu item follows the policy live
add_task(async function test_inspect_context_item_respects_policy() {
  await BrowserTestUtils.withNewTab(
    "data:text/html,<body>context menu</body>",
    async browser => {
      await checkInspectContextItem(browser, true);

      Services.prefs.setBoolPref(DEVTOOLS_DISABLED_PREF, true);
      await checkInspectContextItem(browser, false);

      Services.prefs.setBoolPref(DEVTOOLS_DISABLED_PREF, false);
      await checkInspectContextItem(browser, true);

      Services.prefs.clearUserPref(DEVTOOLS_DISABLED_PREF);
    }
  );
});
