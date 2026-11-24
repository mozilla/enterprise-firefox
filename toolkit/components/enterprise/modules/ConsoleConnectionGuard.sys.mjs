/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient:
    "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs",
  createEnterpriseLogger:
    "moz-src:///toolkit/components/enterprise/modules/EnterpriseCommon.sys.mjs",
  ForcedQuitHandler:
    "moz-src:///toolkit/components/enterprise/modules/ForcedQuitHandler.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("ConsoleConnectionGuard");
});

const ENABLED_PREF = "enterprise.network_loss.enabled";
const GRACE_PERIOD_PREF = "enterprise.network_loss.grace_period_minutes";
const LOCKING_PREF = "enterprise.locking.network_loss";
const GRACE_PERIOD_DEFAULT_MINUTES = 720;
// Keep the grace period within the signed 32-bit millisecond timer limit.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const GRACE_PERIOD_MAX_MINUTES = Math.floor(MAX_TIMER_DELAY_MS / (60 * 1000));
const ENFORCEMENT_RETRY_MS = 5000;
// FELT explains the ended session to the user by this reason.
const NETWORK_LOSS_REASON = "networkLoss";
const REACHABILITY_PROBE_TIMEOUT_MS = 5000;
const CONFIRMATION_DELAY_MS = 2 * 60 * 1000;

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
  _firstFailedProbeAt: null,
  // Latches for the process lifetime; ending the session tears the browser down.
  _sessionEnded: false,
  _pendingSessionEnd: null,

  /**
   * Whether the NetworkLoss policy is enforced, so a console the browser
   * cannot reach is left to the grace period instead of ending the session.
   *
   * @returns {boolean}
   */
  get isEnabled() {
    return Services.prefs.getBoolPref(ENABLED_PREF, false);
  },

  /**
   * Record that the console responded, clearing any in-progress grace period.
   */
  recordReachable() {
    // Enforcement only starts once the deadline probe found the console gone,
    // so the outage stands until it settles; a failed attempt then retries.
    if (
      this._pendingSessionEnd ||
      (this._timer === null && this._outageStartedAt === null)
    ) {
      return;
    }
    lazy.log.debug("Console reachable again; clearing network-loss timer.");
    this._clearOutage();
  },

  /**
   * Record that the console could not be reached, starting the grace period on
   * the first failure.
   */
  recordUnreachable() {
    if (
      !Services.felt?.isFeltBrowser() ||
      !this.isEnabled ||
      this._sessionEnded ||
      this._pendingSessionEnd
    ) {
      return;
    }
    if (this._outageStartedAt !== null) {
      // Timers do not advance while the machine sleeps on macOS and Linux, so
      // the deadline can pass without its timer firing.
      if (this._remainingGraceMs() <= 0 && this._firstFailedProbeAt === null) {
        this._verifyBeforeEnforcing();
      }
      return;
    }
    if (this._timer !== null) {
      return;
    }
    this._outageStartedAt = Date.now();
    this._scheduleGraceTimer();
  },

  /**
   * Time left before the session is ended.
   *
   * @returns {number}
   */
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

  /**
   * Arms the timer for the end of the grace period.
   */
  _scheduleGraceTimer() {
    this._cancelVerification();
    this._firstFailedProbeAt = null;
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

  /**
   * Abandons any in-flight reachability probe.
   */
  _cancelVerification() {
    this._verificationGeneration++;
    this._probeController?.abort();
    this._probeController = null;
  },

  /**
   * Probes the console once more at the deadline, enforcing only if it is
   * still unreachable.
   *
   * @returns {Promise<void>}
   */
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
        } else if (
          this._firstFailedProbeAt === null ||
          Date.now() - this._firstFailedProbeAt > 2 * CONFIRMATION_DELAY_MS
        ) {
          // After a long sleep the deadline has already passed on wake, so the
          // first probe can run before Wi-Fi or a VPN reconnects. Only a second
          // failure a little later ends the session. One that runs long after it
          // was due slept through the wait, so the wait starts over.
          this._firstFailedProbeAt = Date.now();
          this._timer = lazy.setTimeout(
            () => this._verifyBeforeEnforcing(),
            CONFIRMATION_DELAY_MS
          );
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

  /**
   * Ends the outage, cancelling its timers.
   */
  _clearOutage() {
    this._cancelVerification();
    this._firstFailedProbeAt = null;
    if (this._timer !== null) {
      lazy.clearTimeout(this._timer);
      this._timer = null;
    }
    this._outageStartedAt = null;
  },

  /**
   * Clear all guard state. Exposed for tests so it does not leak across tasks.
   */
  reset() {
    this._clearOutage();
    this._sessionEnded = false;
    this._pendingSessionEnd = null;
  },

  /**
   * Ends the FELT session, locking it or signing it out with the networkLoss
   * reason so FELT can explain why the session ended. Both paths leave through
   * a forced quit, which bypasses the browser's own close prompts.
   *
   * @param {boolean} aLockSession - Whether to lock rather than sign out.
   * @returns {Promise<boolean>} Whether ending the session was initiated.
   */
  async _endSession(aLockSession) {
    if (!Services.felt?.isFeltBrowser()) {
      return false;
    }

    try {
      if (aLockSession) {
        // NetworkLoss decides this independently of the application's
        // shutdown-locking setting, so push it before the quit it rides out on.
        Services.felt.setShutdownLockIntent(true, NETWORK_LOSS_REASON);
        await lazy.ForcedQuitHandler.quitIgnoringCanClose();
        if (Services.startup.shuttingDown) {
          return true;
        }
      }
      Services.felt.setShutdownLockIntent(false, NETWORK_LOSS_REASON);
      Services.felt.performSignoutWithReason(NETWORK_LOSS_REASON);
      // FELT also shuts the browser down on signout; quitting here keeps that
      // from depending on FELT answering.
      await lazy.ForcedQuitHandler.quitIgnoringCanClose();
      return true;
    } catch (e) {
      // The FELT IPC calls only throw when the browser-side client is missing,
      // which should not happen in a FELT browser. The console is gone, so
      // ending the session still matters more than how it ends.
      lazy.log.warn(`Unable to end the session on network loss: ${e}`);
      try {
        // FELT reads a plain quit as an ordinary shutdown, so leaving the
        // application's intent in place would apply the Shutdown action here
        // instead of the NetworkLoss one the administrator configured.
        Services.felt.setShutdownLockIntent(aLockSession, NETWORK_LOSS_REASON);
      } catch (intentError) {
        lazy.log.error(
          `Unable to declare the network-loss intent, so the shutdown action applies instead: ${intentError}`
        );
      }
      await lazy.ForcedQuitHandler.quitIgnoringCanClose();
      return Services.startup.shuttingDown;
    }
  },

  /**
   * Ends the session per the NetworkLoss action, retrying if it fails while
   * the outage lasts.
   *
   * @returns {Promise<boolean>} Whether the session was ended.
   */
  async _enforce() {
    if (this._sessionEnded) {
      return true;
    }
    if (this._pendingSessionEnd) {
      return this._pendingSessionEnd;
    }
    if (!this.isEnabled) {
      this._clearOutage();
      return false;
    }
    this._cancelVerification();
    if (this._timer !== null) {
      lazy.clearTimeout(this._timer);
      this._timer = null;
    }
    const lockSession = Services.prefs.getBoolPref(LOCKING_PREF, false);
    const action = lockSession ? "lock" : "signout";
    lazy.log.warn(
      `Console unreachable past the grace period; enforcing "${action}".`
    );
    this._pendingSessionEnd = (async () => {
      try {
        this._sessionEnded = await this._endSession(lockSession);
      } catch (e) {
        lazy.log.error("Failed to end the session on network loss.", e);
        return false;
      }
      if (this._sessionEnded) {
        this._clearOutage();
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
