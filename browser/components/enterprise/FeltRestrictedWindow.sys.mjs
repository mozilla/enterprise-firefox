/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Editing, find, navigation, zoom and window management only.
const ALLOWED_KEYS = new Set([
  "key_undo",
  "key_redo",
  "key_cut",
  "key_copy",
  "key_paste",
  "key_delete",
  "key_selectAll",
  "key_find",
  "key_findAgain",
  "key_findPrevious",
  "key_findSelection",
  "key_findAgain2",
  "key_findPrevious2",
  "key_close",
  "key_closeWindow",
  "goBackKb",
  "goForwardKb",
  "goBackKb2",
  "goForwardKb2",
  "key_reload",
  "key_reload2",
  "key_reload_skip_cache",
  "key_reload_skip_cache2",
  "key_stop",
  "key_stop_mac",
  "key_fullZoomReduce",
  "key_fullZoomEnlarge",
  "key_fullZoomReset",
  "key_minimizeWindow",
  "key_hideThisAppCmdMac",
  "key_hideOtherAppsCmdMac",
  "key_quitApplication",
]);

// macOS application menu items that need to be removed.
const APP_MENU_ITEMS = [
  "aboutName",
  "menu_referralsPage",
  "menu_settings",
  "menu_preferences",
  "menu_setAsDefault",
];

/**
 * Restricts the browser windows of the Felt UI process to the content they
 * load, with no toolbars and no shortcuts that open other content.
 */
export const FeltRestrictedWindow = {
  /**
   * @param {Window} win A browser.xhtml window in the Felt UI process.
   */
  init(win) {
    const doc = win.document;
    // Hide toolbars
    for (const toolbar of doc.querySelectorAll(
      "#navigator-toolbox > toolbar"
    )) {
      toolbar.setAttribute("hide-in-felt", "true");
    }
    // Use the native titlebar, as the tabs toolbar that replaces it is hidden.
    win.CustomTitlebar.allowedBy("felt", false);
    for (const menu of doc.querySelectorAll("#main-menubar > menu")) {
      menu.hidden = true;
    }
    // Disable any keyboard shortcut not explicitly allowed
    for (const key of doc.getElementsByTagName("key")) {
      if (!ALLOWED_KEYS.has(key.id)) {
        key.setAttribute("disabled", "true");
      }
    }

    // Run after gBrowserInit's DOMContentLoaded listener.
    win.addEventListener(
      "DOMContentLoaded",
      () => {
        // Disable dropped-link handling
        win.gBrowser.selectedBrowser.droppedLinkHandler = null;
        win.gBrowser.tabContainer.addEventListener(
          "TabBrowserInserted",
          event => {
            event.target.linkedBrowser.droppedLinkHandler = null;
          }
        );
      },
      { once: true }
    );
  },

  /**
   * Removes the entries that open other content from the macOS application
   * menu. Must run before the native menu bar of the window is built.
   *
   * @param {Document} doc The macOS hidden window document.
   */
  restrictAppMenu(doc) {
    for (const id of APP_MENU_ITEMS) {
      doc.getElementById(id)?.setAttribute("collapsed", "true");
    }
  },
};
