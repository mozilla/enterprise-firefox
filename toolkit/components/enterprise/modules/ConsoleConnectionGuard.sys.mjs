/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
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

const ENABLED_PREF = "enterprise.network_loss.enabled";
const GRACE_PERIOD_PREF = "enterprise.network_loss.grace_period_minutes";
const GRACE_PERIOD_DEFAULT_MINUTES = 480;
// Keep the grace period within the signed 32-bit millisecond timer limit.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const GRACE_PERIOD_MAX_MINUTES = Math.floor(MAX_TIMER_DELAY_MS / (60 * 1000));
const ENFORCEMENT_RETRY_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const REACHABILITY_PROBE_TIMEOUT_MS = 5000;

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
  _outageStartedAt: null,
  _verificationGeneration: 0,
  _probeController: null,
  // Latches for the process lifetime; ending the session tears the browser down.
  _sessionEnded: false,
  _pendingSessionEnd: null,
  _shutdownWatchdog: null,

  /**
   * Record that the console responded, clearing any in-progress grace period.
   */
  recordReachable() {
    if (Services.felt?.isFeltUI()) {
      this._relayReachability(true);
      return;
    }
    if (this._timer === null && this._outageStartedAt === null) {
      return;
    }
    lazy.log.debug("Console reachable again; clearing network-loss timer.");
    this._clearOutage();
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
      !Services.prefs.getBoolPref(ENABLED_PREF, false) ||
      this._sessionEnded ||
      this._pendingSessionEnd ||
      this._outageStartedAt !== null ||
      this._timer !== null
    ) {
      return;
    }
    this._outageStartedAt = Date.now();
    Services.prefs.addObserver(ENABLED_PREF, this);
    Services.prefs.addObserver(GRACE_PERIOD_PREF, this);
    this._scheduleGraceTimer();
  },

  observe(_subject, topic, pref) {
    if (topic !== "nsPref:changed" || this._pendingSessionEnd) {
      return;
    }
    if (pref === ENABLED_PREF) {
      if (!Services.prefs.getBoolPref(ENABLED_PREF, false)) {
        this._clearOutage();
      }
    } else if (pref === GRACE_PERIOD_PREF) {
      this._scheduleGraceTimer();
    }
  },

  _remainingGraceMs() {
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
    return Math.max(0, graceMs - (Date.now() - this._outageStartedAt));
  },

  _scheduleGraceTimer() {
    this._cancelVerification();
    const remainingMs = this._remainingGraceMs();
    lazy.log.debug(
      `Console unreachable; ${remainingMs}ms remain in network-loss grace period.`
    );
    if (this._timer !== null) {
      lazy.clearTimeout(this._timer);
    }
    this._timer = lazy.setTimeout(
      () => this._verifyBeforeEnforcing(),
      remainingMs
    );
  },

  _cancelVerification() {
    this._verificationGeneration++;
    this._probeController?.abort();
    this._probeController = null;
  },

  async _verifyBeforeEnforcing() {
    if (
      this._outageStartedAt === null ||
      this._probeController ||
      this._sessionEnded ||
      this._pendingSessionEnd ||
      Services.startup.shuttingDown
    ) {
      return;
    }
    if (this._remainingGraceMs() > 0) {
      this._scheduleGraceTimer();
      return;
    }
    lazy.clearTimeout(this._timer);
    this._timer = null;
    const generation = this._verificationGeneration;
    const controller = new AbortController();
    this._probeController = controller;
    try {
      await lazy.ConsoleClient.probeConsoleReachable({
        timeoutMs: REACHABILITY_PROBE_TIMEOUT_MS,
        signal: controller.signal,
      });
      if (generation === this._verificationGeneration) {
        this.recordReachable();
      }
    } catch (e) {
      if (
        generation !== this._verificationGeneration ||
        this._outageStartedAt === null ||
        Services.startup.shuttingDown
      ) {
        return;
      }
      if (lazy.ConsoleClient.isTransportError(e)) {
        if (this._remainingGraceMs() > 0) {
          this._scheduleGraceTimer();
        } else {
          await this._enforce();
        }
      } else {
        lazy.log.error("Could not verify console reachability; retrying.", e);
        this._timer = lazy.setTimeout(
          () => this._verifyBeforeEnforcing(),
          ENFORCEMENT_RETRY_MS
        );
      }
    } finally {
      if (this._probeController === controller) {
        this._probeController = null;
      }
    }
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

  _clearOutage() {
    this._cancelVerification();
    if (this._timer !== null) {
      lazy.clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._outageStartedAt !== null) {
      Services.prefs.removeObserver(ENABLED_PREF, this);
      Services.prefs.removeObserver(GRACE_PERIOD_PREF, this);
      this._outageStartedAt = null;
    }
  },

  /**
   * Clear all guard state. Exposed for tests so it does not leak across tasks.
   */
  reset() {
    this._clearOutage();
    this._sessionEnded = false;
    this._pendingSessionEnd = null;
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
    if (this._sessionEnded) {
      return true;
    }
    if (this._pendingSessionEnd) {
      return this._pendingSessionEnd;
    }
    if (!Services.prefs.getBoolPref(ENABLED_PREF, false)) {
      this._clearOutage();
      return false;
    }
    this._cancelVerification();
    if (this._timer !== null) {
      lazy.clearTimeout(this._timer);
      this._timer = null;
    }
    const lockSession = Services.prefs.getBoolPref(
      "enterprise.locking.network_loss",
      false
    );
    const action = lockSession ? "lock" : "signout";
    lazy.log.warn(
      `Console unreachable past the grace period; enforcing "${action}".`
    );
    this._pendingSessionEnd = (async () => {
      try {
        this._sessionEnded =
          await lazy.EnterpriseHandler.endSessionForNetworkLoss(lockSession);
      } catch (e) {
        lazy.log.error("Failed to end the session on network loss.", e);
        return false;
      }
      if (this._sessionEnded) {
        this._clearOutage();
        Services.obs.notifyObservers(null, NETWORK_LOSS_ENFORCED_TOPIC, action);
        if (!Services.startup.shuttingDown) {
          this._shutdownWatchdog = lazy.setTimeout(
            () => this._forceNetworkLossShutdown(),
            SHUTDOWN_TIMEOUT_MS
          );
        }
      }
      return this._sessionEnded;
    })();
    try {
      const sessionEnded = await this._pendingSessionEnd;
      if (!sessionEnded && this._outageStartedAt !== null) {
        this._timer = lazy.setTimeout(
          () => this._verifyBeforeEnforcing(),
          ENFORCEMENT_RETRY_MS
        );
      }
      return sessionEnded;
    } finally {
      this._pendingSessionEnd = null;
    }
  },
};
