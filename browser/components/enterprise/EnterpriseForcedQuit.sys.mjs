/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  InfoBar: "resource:///modules/asrouter/InfoBar.sys.mjs",
  RelaunchEnforcer:
    "resource://gre/modules/enterprise/RelaunchEnforcer.sys.mjs",
  RelaunchPhase: "resource://gre/modules/enterprise/RelaunchEnforcer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("EnterpriseForcedQuit");
});

const WARNING_ID = "ENTERPRISE_RELAUNCH_WARNING";
const IMMINENT_ID = "ENTERPRISE_RELAUNCH_IMMINENT";

// InfoBar serves one message at a time, and yields the slot only to a message
// naming the incumbent. These are the in-tree infobar messages; a message from
// Nimbus or Remote Settings holds the slot until the next poll retries. Keep it
// in step with the ids the in-tree message providers author.
const REPLACEABLE_IDS = [
  WARNING_ID,
  IMMINENT_ID,
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
 * The relaunch warning RelaunchEnforcer drives: an InfoBar shown across
 * browser windows.
 */
const warningUI = {
  _notification: null,
  // The bar's action handler is bound once at creation, so the latest restart
  // callback lives here. RelaunchEnforcer invalidates stale ones itself.
  _restartNow: null,

  /**
   * Shows the warning, or brings the one that is up in line with the deadline.
   *
   * @param {object} details
   * @param {string} details.phase - A RelaunchPhase value.
   * @param {number} details.restartAt - The deadline, in epoch ms.
   * @param {number} details.minutes - Minutes remaining until the deadline.
   * @param {function(): void} details.restartNow - Restarts right away.
   * @returns {Promise<boolean>} Whether the warning is visible.
   */
  async showOrUpdate({ phase, restartAt, minutes, restartNow }) {
    this._restartNow = restartNow;
    const isImminent = phase === lazy.RelaunchPhase.IMMINENT;
    const id = isImminent ? IMMINENT_ID : WARNING_ID;

    // Updating the bar already up keeps focus on its button. It also keeps a
    // re-show under an id InfoBar is still tracking off the table, which
    // would leave the new bar out of its bookkeeping and unremovable.
    if (
      this.isVisible() &&
      lazy.InfoBar._activeInfobar.message.id === id &&
      this._setBarVariable(
        id,
        isImminent ? "minutes" : "datetime",
        isImminent ? minutes : restartAt
      )
    ) {
      return true;
    }

    const win = this._barWindow();
    if (!win) {
      // The first poll precedes session restore; the next poll retries.
      return false;
    }

    const message = {
      id,
      content: {
        priority: isImminent
          ? win.gNotificationBox.PRIORITY_CRITICAL_HIGH
          : win.gNotificationBox.PRIORITY_INFO_HIGH,
        type: "universal",
        dismissable: false,
        text: {
          string_id: isImminent
            ? "enterprise-relaunch-imminent-message"
            : "enterprise-relaunch-warning-message",
        },
        buttons: [
          {
            label: { string_id: "enterprise-relaunch-restart-now" },
            action: { type: "RESTART_APP", dismiss: false },
          },
        ],
        attributes: isImminent ? { minutes } : { datetime: restartAt },
        canReplace: REPLACEABLE_IDS,
      },
      template: "infobar",
      targeting: "true",
      groups: [],
    };

    const notification = await lazy.InfoBar.showInfoBarMessage(
      win.gBrowser.selectedBrowser,
      message,
      action => {
        if (
          action?.type === "USER_ACTION" &&
          action.data?.type === "RESTART_APP"
        ) {
          this._restartNow?.();
        }
      }
    );

    if (!notification) {
      // The restart still lands on schedule, so say who kept the warning off.
      lazy.log.warn(
        `The infobar slot is held by ${lazy.InfoBar._activeInfobar?.message?.id}; the relaunch warning is not shown.`
      );
      return false;
    }

    this._notification = notification;
    return true;
  },

  hide() {
    // A bar InfoBar lost track of is not in the list removeUniversalInfobars()
    // walks, so take ours out of each window by hand. Skipping the animation
    // removes the element, and runs InfoBar's own teardown, before returning.
    let removed = false;
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const id of [WARNING_ID, IMMINENT_ID]) {
        const bar = win.gNotificationBox?.getNotificationWithValue(id);
        if (bar) {
          win.gNotificationBox.removeNotification(bar, true);
          removed = true;
        }
      }
    }
    // Releases the slot, and the new-window observer, InfoBar may still hold.
    if (removed || this.isVisible()) {
      this._notification?.removeUniversalInfobars();
    }
    this._notification = null;
    this._restartNow = null;
  },

  // InfoBar hands the slot to another message, and closing the last window on
  // macOS takes the bar with it.
  isVisible() {
    return (
      !!this._notification &&
      lazy.InfoBar._activeInfobar?.notification === this._notification
    );
  },

  /**
   * The window to show the warning from. The most recent window can be a
   * private window, a popup or a taskbar tab, and InfoBar refuses all of those.
   *
   * InfoBar is only reached once a window exists, so the first poll does not
   * drag its module graph into "policies-startup".
   *
   * @returns {Window|null} null when no open window can take a bar.
   */
  _barWindow() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.gBrowser && lazy.InfoBar.isValidInfobarWindow(win)) {
        return win;
      }
    }
    return null;
  },

  /**
   * Puts a new value in one Fluent variable of the bars that are up, in every
   * window.
   *
   * @param {string} barId - The id of the bar to update.
   * @param {string} name - The Fluent variable name.
   * @param {string|number} value - The value to substitute.
   * @returns {boolean} Whether a bar took the new value.
   */
  _setBarVariable(barId, name, value) {
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
      const { attributes } =
        lazy.InfoBar._activeInfobar?.message?.content ?? {};
      if (attributes) {
        attributes[name] = value;
      }
    }
    return updated;
  },
};

/**
 * Firefox's side of console-driven forced quits and relaunches: the warning
 * UI and the pre-quit preparation the toolkit modules delegate to the
 * application.
 */
export const EnterpriseForcedQuit = {
  warningUI,
};

/**
 * Prevents page and tab-close callbacks from vetoing a console-mandated quit.
 * Exported through the "enterprise-forced-quit-hook" category in components.conf.
 */
export function beforeForcedQuit() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    win.skipNextCanClose = true;
  }
}

/** The "enterprise-relaunch-warning-ui" entry point (see components.conf). */
export function registerRelaunchWarningUI() {
  lazy.RelaunchEnforcer.registerWarningUIDelegate(
    EnterpriseForcedQuit.warningUI
  );
}
