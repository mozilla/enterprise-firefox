/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  InfoBar: "resource:///modules/asrouter/InfoBar.sys.mjs",
});

// InfoBar serves one message at a time, and yields the slot only to a message
// naming the incumbent. These are the in-tree infobar messages; a message from
// Nimbus or Remote Settings holds the slot until the next poll retries. Keep it
// in step with the ids the in-tree message providers author.
export const REPLACEABLE_IDS = [
  "ENTERPRISE_RELAUNCH_WARNING",
  "ENTERPRISE_RELAUNCH_IMMINENT",
  "ENTERPRISE_NETWORK_LOSS_WARNING",
  "ENTERPRISE_NETWORK_LOSS_IMMINENT",
  "COMPULSORY_RESTART_SCHEDULED",
  "INFOBAR_ACTION_86",
  "INFOBAR_DEFAULT_AND_PIN_87",
  "INFOBAR_LAUNCH_ON_LOGIN",
  "INFOBAR_LAUNCH_ON_LOGIN_FINAL",
  "MULTIPROFILE_DATA_COLLECTION_CHANGED_INFOBAR",
  "PREF_OBSERVER_MESSAGE_94",
  "updated-privacy-notice-notification-infobar",
];

/**
 * The window to show a warning from. The most recent window can be a private
 * window, a popup or a taskbar tab, and InfoBar refuses all of those.
 *
 * InfoBar is only reached once a window exists, so the first poll does not
 * drag its module graph into "policies-startup".
 *
 * @returns {Window|null} null when no open window can take a bar.
 */
export function findBarWindow() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (
      win.gBrowser &&
      // TODO(Bug 2066128): Remove once InfoBar handles loading windows.
      win.document.readyState === "complete" &&
      lazy.InfoBar.isValidInfobarWindow(win)
    ) {
      return win;
    }
  }
  return null;
}

/**
 * Puts a new value in one Fluent variable of the bars that are up, in every
 * window.
 *
 * @param {string} barId - The id of the bar to update.
 * @param {string} name - The Fluent variable name.
 * @param {string|number} value - The value to substitute.
 * @returns {boolean} Whether a bar took the new value.
 */
export function setBarVariable(barId, name, value) {
  let updated = false;
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    const bar = win.gNotificationBox?.getNotificationWithValue(barId);
    const remote = bar?.querySelector("remote-text");
    if (remote) {
      remote.setVariable(name, value);
      updated = true;
    }
  }
  if (updated) {
    // A window opened from here on is served the stored message, not the DOM.
    const { attributes } = lazy.InfoBar._activeInfobar?.message?.content ?? {};
    if (attributes) {
      attributes[name] = value;
    }
  }
  return updated;
}

/**
 * Removes the bars carrying any of `barIds` from every window, and releases
 * the InfoBar slot a bar it lost track of would otherwise keep holding.
 *
 * @param {string[]} barIds - The ids to take down.
 * @param {object|null} notification - The InfoBar notification to release.
 * @returns {void}
 */
export function removeBars(barIds, notification) {
  // A bar InfoBar lost track of is not in the list removeUniversalInfobars()
  // walks, so take ours out of each window by hand. Skipping the animation
  // removes the element, and runs InfoBar's own teardown, before returning.
  let removed = false;
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    for (const id of barIds) {
      const bar = win.gNotificationBox?.getNotificationWithValue(id);
      if (bar) {
        win.gNotificationBox.removeNotification(bar, true);
        removed = true;
      }
    }
  }
  if (removed || lazy.InfoBar._activeInfobar?.notification === notification) {
    notification?.removeUniversalInfobars();
  }
}
