/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("ConsoleConnectionGuard");
});

const ENABLED_PREF = "enterprise.signout.network_loss.enabled";
const GRACE_PERIOD_PREF = "enterprise.signout.network_loss.grace_period";
const GRACE_PERIOD_DEFAULT_S = 300;

/**
 * Enforces a sign-out when the enterprise console has been unreachable for a
 * sustained grace period. Losing the console means we can no longer refresh
 * policy or device posture, nor receive a forced revocation, so the session is
 * ended to keep the account secure.
 */
export const ConsoleConnectionGuard = {
  _timer: null,
  // Latches for the process lifetime; the sign-out path restarts Firefox.
  _signoutTriggered: false,

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
   * Record that the console could not be reached. Starts the grace period on the
   * first failure and the sign-out is enforced once the configured timeout elapses.
   */
  recordUnreachable() {
    if (
      // The FELT UI process makes its own failing console calls while signing
      // out; only the browser process's policy poll should drive this guard.
      Services.felt.isFeltUI() ||
      this._signoutTriggered ||
      this._timer !== null ||
      !Services.prefs.getBoolPref(ENABLED_PREF, false)
    ) {
      return;
    }
    const graceMs =
      Services.prefs.getIntPref(GRACE_PERIOD_PREF, GRACE_PERIOD_DEFAULT_S) *
      1000;
    lazy.log.debug(
      `Console unreachable; starting ${graceMs}ms network-loss grace period.`
    );
    this._timer = lazy.setTimeout(() => this._enforceSignout(), graceMs);
  },

  /**
   * Clear all guard state. Exposed for tests so it does not leak across tasks.
   */
  reset() {
    if (this._timer !== null) {
      lazy.clearTimeout(this._timer);
      this._timer = null;
    }
    this._signoutTriggered = false;
  },

  _enforceSignout() {
    this._timer = null;
    if (this._signoutTriggered) {
      return;
    }
    if (!Services.prefs.getBoolPref(ENABLED_PREF, false)) {
      return;
    }
    lazy.log.warn(
      "Console unreachable past the grace period; enforcing network-loss sign-out."
    );
    try {
      Services.felt.performSignoutWithReason("networkLoss");
      this._signoutTriggered = true;
    } catch (e) {
      lazy.log.error("Failed to trigger network-loss sign-out.", e);
    }
  },
};
