/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

// This test verifies that the sidebar is hidden when the nav toolbox is
// autohidden in F11 fullscreen mode, and restored when exiting fullscreen.
// This should not be run on macOS because we don't hide the toolbars there.

"use strict";

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      [VERTICAL_TABS_PREF, true],
      ["browser.fullscreen.autohide", true],
    ],
  });
  await SidebarTestUtils.waitForTabstripOrientation(window, "vertical");
});

registerCleanupFunction(async () => {
  // Only restores the primary test window. Extra windows opened by
  // individual tasks must be closed within those tasks.
  if (window.fullScreen) {
    let onFullscreen = BrowserTestUtils.waitForEvent(window, "fullscreen");
    document.getElementById("View:FullScreen").doCommand();
    await onFullscreen;
  }
});

async function enterFullscreenAndWaitForHiddenToolbox() {
  // Start observing before triggering so we can't miss the notification
  // whether it fires synchronously during fullscreen entry or later.
  let onToolboxHidden = TestUtils.topicObserved(
    "fullscreen-nav-toolbox",
    (subject, data) => data == "hidden"
  );
  let onFullscreen = BrowserTestUtils.waitForEvent(window, "fullscreen");
  document.getElementById("View:FullScreen").doCommand();
  await onFullscreen;
  await SimpleTest.promiseFocus(window);
  await onToolboxHidden;
}

async function exitFullscreen() {
  let onFullscreen = BrowserTestUtils.waitForEvent(window, "fullscreen");
  document.getElementById("View:FullScreen").doCommand();
  await onFullscreen;
}

add_task(async function test_f11_fullscreen_hides_sidebar() {
  const { sidebarMain } = SidebarController;
  await SidebarController.promiseInitialized;

  ok(
    BrowserTestUtils.isVisible(sidebarMain),
    "Sidebar main is initially visible"
  );

  const tabbox = document.getElementById("tabbrowser-tabbox");
  ok(
    tabbox.hasAttribute("sidebar-shown"),
    "tabbrowser-tabbox has sidebar-shown attribute initially"
  );

  await enterFullscreenAndWaitForHiddenToolbox();
  ok(window.fullScreen, "Window is in fullscreen mode");

  // Sidebar elements should be collapsed.
  ok(
    document.documentElement.hasAttribute("fullscreenNavToolboxHidden"),
    "Root has fullscreenNavToolboxHidden attribute"
  );
  ok(
    !tabbox.hasAttribute("sidebar-shown"),
    "tabbrowser-tabbox does not have sidebar-shown attribute when toolbox is hidden"
  );

  // Show the nav toolbox.
  let onToolboxShown = TestUtils.topicObserved(
    "fullscreen-nav-toolbox",
    (subject, data) => data == "shown"
  );
  FullScreen.showNavToolbox();
  await onToolboxShown;

  // Sidebar should be visible again.
  ok(
    !document.documentElement.hasAttribute("fullscreenNavToolboxHidden"),
    "Root attribute is cleared when toolbox is shown"
  );
  ok(
    tabbox.hasAttribute("sidebar-shown"),
    "tabbrowser-tabbox has sidebar-shown attribute when toolbox is shown"
  );

  // Hide the nav toolbox again.
  let onToolboxHidden = TestUtils.topicObserved(
    "fullscreen-nav-toolbox",
    (subject, data) => data == "hidden"
  );
  FullScreen.hideNavToolbox();
  await onToolboxHidden;

  ok(
    document.documentElement.hasAttribute("fullscreenNavToolboxHidden"),
    "Root attribute is reapplied when toolbox is re-hidden"
  );
  ok(
    !tabbox.hasAttribute("sidebar-shown"),
    "tabbrowser-tabbox loses sidebar-shown when toolbox is re-hidden"
  );

  await exitFullscreen();
  ok(!window.fullScreen, "Window has exited fullscreen mode");

  ok(
    BrowserTestUtils.isVisible(sidebarMain),
    "Sidebar main is visible after exiting fullscreen"
  );
  ok(
    tabbox.hasAttribute("sidebar-shown"),
    "tabbrowser-tabbox has sidebar-shown attribute after exiting fullscreen"
  );
});

add_task(async function test_exit_fullscreen_restores_sidebar() {
  await SidebarController.promiseInitialized;

  const tabbox = document.getElementById("tabbrowser-tabbox");

  await enterFullscreenAndWaitForHiddenToolbox();

  ok(
    document.documentElement.hasAttribute("fullscreenNavToolboxHidden"),
    "Root has fullscreenNavToolboxHidden attribute in fullscreen"
  );

  // Exit fullscreen directly without showing toolbox first.
  await exitFullscreen();
  ok(!window.fullScreen, "Window has exited fullscreen mode");

  ok(
    !document.documentElement.hasAttribute("fullscreenNavToolboxHidden"),
    "Root attribute is cleared after exiting fullscreen"
  );
  ok(
    tabbox.hasAttribute("sidebar-shown"),
    "tabbrowser-tabbox has sidebar-shown attribute after exiting fullscreen"
  );
});
