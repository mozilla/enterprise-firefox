/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
  EnterpriseHandler: "resource:///modules/enterprise/EnterpriseHandler.sys.mjs",
  hasActiveFirefoxSession: "chrome://felt/content/FeltProcessParent.sys.mjs",
  ForcedQuitHandler:
    "resource://gre/modules/enterprise/ForcedQuitHandler.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("ConsoleConnectionGuard");
});

const GRACE_PERIOD_PREF = "enterprise.network_loss.grace_period_minutes";
const GRACE_PERIOD_DEFAULT_MINUTES = 15;
const GRACE_PERIOD_MAX_MINUTES = 35791;
const ENFORCEMENT_RETRY_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 5000;

/**
 * Fired once the session has been ended because the console stayed unreachable
 * for the whole grace period. Carries the action taken as its data.
 */
export const NETWORK_LOSS_ENFORCED_TOPIC = "enterprise-network-loss-enforced";

/**
 * Ends the session when the enterprise console has been unreachable for a
 * sustained grace period. Losing the console means we can no longer refresh
 * policy or device posture, nor receive a forced revocation, so the session is
 * locked or signed out (per the SignOut NetworkLoss policy) to keep the
 * account secure.
 */
export const ConsoleConnectionGuard = {
  _timer: null,
  // Latches for the process lifetime; ending the session tears the browser down.
  _enforced: false,
  _enforcing: null,
  _shutdownWatchdog: null,

  /**
   * Record that the console responded, clearing any in-progress grace period.
   */
  recordReachable() {
    if (Services.felt?.isFeltUI()) {
      this._relayReachability(true);
      return;
    }
    if (this._timer === null) {
      return;
    }
    lazy.log.debug("Console reachable again; clearing network-loss timer.");
    lazy.clearTimeout(this._timer);
    this._timer = null;
  },

  /**
   * Record that the console could not be reached. FELT relays the failure to
   * the browser, which starts the grace period on the first failure.
   */
  recordUnreachable() {
    if (Services.felt?.isFeltUI()) {
      this._relayReachability(false);
      return;
    }
    if (
      !Services.felt?.isFeltBrowser() ||
      this._enforced ||
      this._enforcing ||
      this._timer !== null
    ) {
      return;
    }
    const graceMs =
      Math.min(
        Math.max(
          Services.prefs.getIntPref(
            GRACE_PERIOD_PREF,
            GRACE_PERIOD_DEFAULT_MINUTES
          ),
          1
        ),
        GRACE_PERIOD_MAX_MINUTES
      ) *
      60 *
      1000;
    lazy.log.debug(
      `Console unreachable; starting ${graceMs}ms network-loss grace period.`
    );
    this._timer = lazy.setTimeout(() => this._enforce(), graceMs);
  },

  _relayReachability(reachable) {
    if (!lazy.hasActiveFirefoxSession()) {
      return;
    }
    try {
      Services.felt.reportConsoleReachability(reachable);
    } catch (e) {
      lazy.log.error("Failed to relay console reachability to Firefox.", e);
    }
  },

  /**
   * Clear all guard state. Exposed for tests so it does not leak across tasks.
   */
  reset() {
    if (this._timer !== null) {
      lazy.clearTimeout(this._timer);
      this._timer = null;
    }
    this._enforced = false;
    this._enforcing = null;
    if (this._shutdownWatchdog !== null) {
      lazy.clearTimeout(this._shutdownWatchdog);
      this._shutdownWatchdog = null;
    }
  },

  async _forceNetworkLossShutdown() {
    if (this._shutdownWatchdog !== null) {
      lazy.clearTimeout(this._shutdownWatchdog);
    }
    this._shutdownWatchdog = null;
    if (Services.startup.shuttingDown) {
      return;
    }
    try {
      await lazy.ForcedQuitHandler.quitIgnoringCanClose();
    } catch (e) {
      lazy.log.error("Failed to force shutdown after network loss.", e);
    }
    if (!Services.startup.shuttingDown) {
      this._shutdownWatchdog = lazy.setTimeout(
        () => this._forceNetworkLossShutdown(),
        ENFORCEMENT_RETRY_MS
      );
    }
  },

  async _enforce() {
    if (this._timer !== null) {
      // No-op when the timer itself fired; cancels the pending timeout when a
      // test drives enforcement directly.
      lazy.clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._enforced) {
      return true;
    }
    if (this._enforcing) {
      return this._enforcing;
    }
    const lockSession = Services.prefs.getBoolPref(
      "enterprise.locking.network_loss",
      false
    );
    const action = lockSession ? "lock" : "signout";
    lazy.log.warn(
      `Console unreachable past the grace period; enforcing "${action}".`
    );
    this._enforcing = (async () => {
      try {
        this._enforced =
          await lazy.EnterpriseHandler.endSessionForNetworkLoss(lockSession);
      } catch (e) {
        lazy.log.error("Failed to end the session on network loss.", e);
        return false;
      }
      if (this._enforced) {
        Services.obs.notifyObservers(null, NETWORK_LOSS_ENFORCED_TOPIC, action);
        if (!Services.startup.shuttingDown) {
          this._shutdownWatchdog = lazy.setTimeout(
            () => this._forceNetworkLossShutdown(),
            SHUTDOWN_TIMEOUT_MS
          );
        }
      }
      return this._enforced;
    })();
    try {
      const enforced = await this._enforcing;
      if (!enforced) {
        this._timer = lazy.setTimeout(
          () => this._enforce(),
          ENFORCEMENT_RETRY_MS
        );
      }
      return enforced;
    } finally {
      this._enforcing = null;
    }
  },
};
