/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BANDWIDTH } from "chrome://browser/content/ipprotection/ipprotection-constants.mjs";

const BANDWIDTH_WARNING_DISMISSED_PREF =
  "browser.ipProtection.bandwidthWarningDismissedThreshold";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  IPPProxyManager:
    "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPProtectionService:
    "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
  IPProtectionStates:
    "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
});

/**
 * Manages displaying bandwidth warning infobars when usage reaches
 * 75% or 90% thresholds based on remaining bandwidth percentage.
 */
class IPProtectionInfobarManagerClass {
  #initialized = false;

  get initialized() {
    return this.#initialized;
  }

  init() {
    if (this.#initialized) {
      return;
    }

    lazy.IPPProxyManager.addEventListener("IPPProxyManager:UsageChanged", this);
    lazy.IPProtectionService.addEventListener(
      "IPProtectionService:StateChanged",
      this
    );

    this.#initialized = true;
  }

  uninit() {
    if (!this.#initialized) {
      return;
    }

    lazy.IPPProxyManager.removeEventListener(
      "IPPProxyManager:UsageChanged",
      this
    );
    lazy.IPProtectionService.removeEventListener(
      "IPProtectionService:StateChanged",
      this
    );

    this.#initialized = false;
  }

  handleEvent(event) {
    if (
      event.type === "IPProtectionService:StateChanged" &&
      lazy.IPProtectionService.state !== lazy.IPProtectionStates.READY
    ) {
      // Eg. hide warnings when signed out
      this.#hideInfobar(75);
      this.#hideInfobar(90);
      return;
    }

    if (event.type === "IPPProxyManager:UsageChanged") {
      const usage = event.detail.usage;
      if (
        !usage ||
        usage.max == null ||
        usage.remaining == null ||
        !usage.reset
      ) {
        return;
      }

      // Calculate what percentage of bandwidth remains
      const remainingPercent = Number(usage.remaining) / Number(usage.max);

      /* Covers the cases where bandwidth hits max or is reset
         Could check for remainingPercent = 1, but there is a chance
         of not having exactly 100% left when this is called, and we
         want to clear the infobar if it's showing and there is less than
         75% usage */
      if (remainingPercent === 0 || remainingPercent > 0.25) {
        Services.prefs.setIntPref(BANDWIDTH_WARNING_DISMISSED_PREF, 0);
        this.#hideInfobar(75);
        this.#hideInfobar(90);
        return;
      }

      // Show 90% warning when 10% or less bandwidth remains
      if (remainingPercent <= 0.1) {
        this.#showInfobar(90, usage);
        // Show 75% warning when bandwidth remaining is between 10% and 25%
      } else if (remainingPercent > 0.1 && remainingPercent <= 0.25) {
        this.#showInfobar(75, usage);
      }
    }
  }

  /**
   * Hide the bandwidth warning infobar if displayed in a browser window.
   *
   * @param {number} threshold - The threshold level (75 or 90)
   */
  #hideInfobar(threshold) {
    const notificationId = `ip-protection-bandwidth-warning-${threshold}`;
    // It's possible for the notification to be in another browser window
    // after navigating away. Clear the notification from all windows if applicable.
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.closed) {
        continue;
      }
      const notification =
        win.gNotificationBox.getNotificationWithValue(notificationId);
      if (notification) {
        win.gNotificationBox.removeNotification(notification);
      }
    }
  }

  /**
   * Display bandwidth warning infobar in the most recently used browser window.
   *
   * @param {number} threshold - The threshold level (75 or 90)
   * @param {object} usage - Usage object containing remaining bandwidth
   */
  #showInfobar(threshold, usage) {
    const notificationId = `ip-protection-bandwidth-warning-${threshold}`;
    const win = Services.wm.getMostRecentWindow("navigator:browser");

    if (!win || win.closed) {
      return;
    }

    if (
      Services.prefs.getIntPref(BANDWIDTH_WARNING_DISMISSED_PREF, 0) >=
      threshold
    ) {
      return;
    }

    // Skip if this window already has the notification
    const existing =
      win.gNotificationBox.getNotificationWithValue(notificationId);
    if (existing) {
      return;
    }

    // Convert bytes to GB for display, using same logic as bandwidth-usage component
    // Convert BigInt to Number first to avoid division errors
    const remainingGB = Number(usage.remaining) / BANDWIDTH.BYTES_IN_GB;

    let usageLeft;
    let l10nId;

    if (threshold === 90 && remainingGB < 1) {
      usageLeft = Math.floor(
        Number(usage.remaining) / BANDWIDTH.BYTES_IN_MB
      ).toString();
      l10nId = "ip-protection-bandwidth-warning-infobar-message-90-mb";
    } else if (threshold === 90) {
      usageLeft = Math.round(remainingGB).toString();
      l10nId = "ip-protection-bandwidth-warning-infobar-message-90";
    } else {
      // 75% threshold
      usageLeft = remainingGB.toFixed(1);
      l10nId = "ip-protection-bandwidth-warning-infobar-message-75";
    }

    // Show the infobar with localized message
    win.gNotificationBox.appendNotification(
      notificationId,
      {
        label: {
          "l10n-id": l10nId,
          "l10n-args": {
            usageLeft,
          },
        },
        priority: win.gNotificationBox.PRIORITY_WARNING_HIGH,
        eventCallback: event => {
          if (event === "dismissed") {
            const current = Services.prefs.getIntPref(
              BANDWIDTH_WARNING_DISMISSED_PREF,
              0
            );
            if (threshold > current) {
              Services.prefs.setIntPref(
                BANDWIDTH_WARNING_DISMISSED_PREF,
                threshold
              );
            }
          }
        },
      },
      [],
      false,
      true
    );
  }
}

const IPProtectionInfobarManager = new IPProtectionInfobarManagerClass();
export { IPProtectionInfobarManager };
