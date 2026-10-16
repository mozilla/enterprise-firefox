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
  ConsoleConnectionGuard:
    "resource://gre/modules/enterprise/ConsoleConnectionGuard.sys.mjs",
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  InfoBar: "resource:///modules/asrouter/InfoBar.sys.mjs",
  NetworkLossPhase:
    "resource://gre/modules/enterprise/ConsoleConnectionGuard.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("EnterpriseNetworkLossWarning");
});

const NETWORK_LOSS_WARNING_ID = "ENTERPRISE_NETWORK_LOSS_WARNING";
const NETWORK_LOSS_IMMINENT_ID = "ENTERPRISE_NETWORK_LOSS_IMMINENT";

// Keyed by NetworkLossPhase, then by the action the deadline carries out.
const NETWORK_LOSS_STRINGS = {
  warning: {
    lock: "enterprise-network-loss-warning-message-lock",
    signout: "enterprise-network-loss-warning-message-signout",
  },
  imminent: {
    lock: "enterprise-network-loss-imminent-message-lock",
    signout: "enterprise-network-loss-imminent-message-signout",
  },
};

/**
 * The network-loss warning ConsoleConnectionGuard drives: an InfoBar shown
 * across browser windows once the enterprise console has been out of reach
 * long enough that the session is heading for its grace-period deadline.
 */
export const networkLossWarningUI = {
  _notification: null,
  // The message last seen holding the InfoBar slot, so a blocker that stays
  // put through the guard's retries is only reported once.
  _blockedBy: null,

  /**
   * Shows the warning, or brings the one that is up in line with the deadline.
   *
   * @param {object} details
   * @param {string} details.phase - A NetworkLossPhase value.
   * @param {number} details.endsAt - The deadline, in epoch ms.
   * @param {number} details.minutes - Minutes remaining until the deadline.
   * @param {boolean} details.willLock - Whether the deadline locks the session
   *   rather than signing out.
   * @returns {Promise<boolean>} Whether the warning is visible.
   */
  async showOrUpdate({ phase, endsAt, minutes, willLock }) {
    const isImminent = phase === lazy.NetworkLossPhase.IMMINENT;
    const id = isImminent ? NETWORK_LOSS_IMMINENT_ID : NETWORK_LOSS_WARNING_ID;
    const stringId = NETWORK_LOSS_STRINGS[phase][willLock ? "lock" : "signout"];

    // A live policy update can change the action mid-outage, and the bar's
    // wording only changes by replacing it.
    if (
      this.isVisible() &&
      lazy.InfoBar._activeInfobar.message.id === id &&
      lazy.InfoBar._activeInfobar.message.content.text.string_id === stringId &&
      setBarVariable(
        id,
        isImminent ? "minutes" : "datetime",
        isImminent ? minutes : endsAt
      )
    ) {
      return true;
    }

    const win = findBarWindow();
    if (!win) {
      // No window can take a bar yet; the next wake-up retries.
      return false;
    }

    const message = {
      id,
      content: {
        priority: isImminent
          ? win.gNotificationBox.PRIORITY_CRITICAL_HIGH
          : win.gNotificationBox.PRIORITY_INFO_HIGH,
        type: "universal",
        // The first bar is a heads-up over a deadline hours away, so it can be
        // put aside; the escalation cannot.
        dismissable: !isImminent,
        text: { string_id: stringId },
        buttons: [],
        attributes: isImminent ? { minutes } : { datetime: endsAt },
        canReplace: REPLACEABLE_IDS,
      },
      template: "infobar",
      targeting: "true",
      groups: [],
    };

    const notification = await lazy.InfoBar.showInfoBarMessage(
      win.gBrowser.selectedBrowser,
      message
    );

    if (!notification) {
      const blockedBy = lazy.InfoBar._activeInfobar?.message?.id;
      if (blockedBy !== this._blockedBy) {
        this._blockedBy = blockedBy;
        // The session still ends on schedule, so say who kept the warning off.
        lazy.log.warn(
          `The infobar slot is held by ${blockedBy}; the network-loss warning is not shown.`
        );
      }
      return false;
    }

    this._blockedBy = null;
    this._notification = notification;
    return true;
  },

  hide() {
    removeBars(
      [NETWORK_LOSS_WARNING_ID, NETWORK_LOSS_IMMINENT_ID],
      this._notification
    );
    this._notification = null;
    this._blockedBy = null;
  },

  isVisible() {
    return (
      !!this._notification &&
      lazy.InfoBar._activeInfobar?.notification === this._notification
    );
  },
};

/** The "enterprise-network-loss-warning-ui" entry point (see components.conf). */
export function registerNetworkLossWarningUI() {
  lazy.ConsoleConnectionGuard.registerWarningUIDelegate(networkLossWarningUI);
}
