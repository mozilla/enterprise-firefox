/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
  EnterpriseHandler: "resource:///modules/enterprise/EnterpriseHandler.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("ConsoleConnectionGuard");
});

const GRACE_PERIOD_PREF = "enterprise.network_loss.grace_period_minutes";
const GRACE_PERIOD_DEFAULT_MINUTES = 5;

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

  /**
   * Record that the console responded, clearing any in-progress grace period.
   */
  recordReachable() {
    if (this._timer === null) {
      return;
    }
    lazy.log.debug("Console reachable again; clearing network-loss timer.");
    lazy.clearTimeout(this._timer);
    this._timer = null;
  },

  /**
   * Record that the console could not be reached. Starts the grace period on
   * the first failure; the session is ended once it elapses.
   */
  recordUnreachable() {
    if (
      // The FELT UI process makes its own failing console calls while ending
      // the session; only the browser process's policy poll drives this guard.
      Services.felt.isFeltUI() ||
      this._enforced ||
      this._timer !== null
    ) {
      return;
    }
    const graceMs =
      Services.prefs.getIntPref(
        GRACE_PERIOD_PREF,
        GRACE_PERIOD_DEFAULT_MINUTES
      ) *
      60 *
      1000;
    lazy.log.debug(
      `Console unreachable; starting ${graceMs}ms network-loss grace period.`
    );
    this._timer = lazy.setTimeout(() => this._enforce(), graceMs);
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
  },

  _enforce() {
    if (this._timer !== null) {
      // No-op when the timer itself fired; cancels the pending timeout when a
      // test drives enforcement directly.
      lazy.clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._enforced) {
      return;
    }
    const action = lazy.EnterpriseHandler.willLockOnNetworkLoss
      ? "lock"
      : "signout";
    lazy.log.warn(
      `Console unreachable past the grace period; enforcing "${action}".`
    );
    try {
      this._enforced = lazy.EnterpriseHandler.endSessionForNetworkLoss();
    } catch (e) {
      lazy.log.error("Failed to end the session on network loss.", e);
      return;
    }
    if (this._enforced) {
      Services.obs.notifyObservers(null, NETWORK_LOSS_ENFORCED_TOPIC, action);
    }
  },
};
