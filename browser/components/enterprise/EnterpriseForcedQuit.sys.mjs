/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  findBarWindow,
  removeBars,
  REPLACEABLE_IDS,
  setBarVariable,
} from "resource:///modules/enterprise/EnterpriseWarningBar.sys.mjs";

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
      setBarVariable(
        id,
        isImminent ? "minutes" : "datetime",
        isImminent ? minutes : restartAt
      )
    ) {
      return true;
    }

    const win = findBarWindow();
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
    removeBars([WARNING_ID, IMMINENT_ID], this._notification);
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
