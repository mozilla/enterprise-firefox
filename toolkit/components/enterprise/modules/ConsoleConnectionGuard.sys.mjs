/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient:
    "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs",
  createEnterpriseLogger:
    "moz-src:///toolkit/components/enterprise/modules/EnterpriseCommon.sys.mjs",
  hasActiveFirefoxSession: "chrome://felt/content/FeltProcessParent.sys.mjs",
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
const MS_PER_MINUTE = 60 * 1000;
// How long an outage must last before the user is told, so a brief blip does
// not raise a bar. Capped at half the grace period so short grace periods are
// still warned about.
const WARNING_DEBOUNCE_MS = 5 * MS_PER_MINUTE;
// How close to the deadline the warning escalates to the imminent phase.
const IMMINENT_THRESHOLD_MS = 60 * MS_PER_MINUTE;
// How soon to try again when no window or InfoBar slot could take the warning.
const WARNING_RETRY_MS = MS_PER_MINUTE;
// The application provides its warning UI through this category. An entry's
// value is the URL of a module exporting registerNetworkLossWarningUI().
// Nothing instantiates the category, so the module loads only when a warning
// is due.
const WARNING_UI_CATEGORY = "enterprise-network-loss-warning-ui";
// The application restores its own lock intents through this category when
// ending the session fails. An entry's value is the URL of a module exporting
// registerNetworkLossLockIntentDelegate().
const LOCK_INTENT_CATEGORY = "enterprise-network-loss-lock-intents";
// FELT explains the ended session to the user by this reason.
const NETWORK_LOSS_REASON = "networkLoss";
const SHUTDOWN_TIMEOUT_MS = 5000;
const REACHABILITY_PROBE_TIMEOUT_MS = 5000;

/**
 * The phases a warning UI delegate's showOrUpdate() can be asked to present.
 */
export const NetworkLossPhase = Object.freeze({
  WARNING: "warning",
  IMMINENT: "imminent",
});

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
  _warningUIDelegate: null,
  _warningUILoaded: false,
  _warningRetryPending: false,
  _lockIntentDelegate: null,
  _lockIntentLoaded: false,

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
   * Registers the application's warning UI, which the guard drives through the
   * grace period. Firefox registers through WARNING_UI_CATEGORY; a delegate
   * stays registered for the lifetime of the application.
   *
   * `showOrUpdate` receives the warning phase, the deadline, the remaining
   * minutes and whether the deadline locks the session, and reports whether a
   * warning is visible afterwards. `hide` must remove any warning even when
   * `isVisible` returns false, and must tolerate repeated calls.
   *
   * @param {object} aDelegate - The warning UI delegate.
   * @param {function(object): (boolean|Promise<boolean>)} aDelegate.showOrUpdate
   * @param {function(): void} aDelegate.hide
   * @param {function(): boolean} aDelegate.isVisible
   * @returns {void}
   */
  registerWarningUIDelegate(aDelegate) {
    if (
      !aDelegate ||
      typeof aDelegate.showOrUpdate !== "function" ||
      typeof aDelegate.hide !== "function" ||
      typeof aDelegate.isVisible !== "function"
    ) {
      throw new TypeError(
        "The warning UI delegate must implement showOrUpdate(), hide(), and isVisible()."
      );
    }
    if (this._warningUIDelegate) {
      throw new Error("A warning UI delegate is already registered.");
    }
    this._warningUIDelegate = aDelegate;
  },

  /**
   * Registers the application's way of restoring the lock intents it normally
   * declares to FELT. Ending the session overrides the shutdown intent with
   * the NetworkLoss action; if the session survives, the application's own
   * intents have to be put back. Firefox registers through
   * LOCK_INTENT_CATEGORY; a delegate stays registered for the lifetime of the
   * application.
   *
   * @param {object} aDelegate - The lock intent delegate.
   * @param {function(): void} aDelegate.restoreLockIntents
   * @returns {void}
   */
  registerLockIntentDelegate(aDelegate) {
    if (!aDelegate || typeof aDelegate.restoreLockIntents !== "function") {
      throw new TypeError(
        "The lock intent delegate must implement restoreLockIntents()."
      );
    }
    if (this._lockIntentDelegate) {
      throw new Error("A lock intent delegate is already registered.");
    }
    this._lockIntentDelegate = aDelegate;
  },

  /**
   * Record that the console responded, clearing any in-progress grace period.
   */
  recordReachable() {
    if (Services.felt?.isFeltUI()) {
      this._relayReachability(true);
      return;
    }
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
    Services.prefs.addObserver(LOCKING_PREF, this);
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
    } else if (pref === LOCKING_PREF) {
      this._updateWarning();
    }
  },

  /**
   * The configured grace period, clamped to what a timer can wait.
   *
   * @returns {number}
   */
  _graceMs() {
    return (
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
      1000
    );
  },

  /**
   * How long an outage lasts before the warning appears.
   *
   * @returns {number}
   */
  _warningDebounceMs() {
    return Math.min(WARNING_DEBOUNCE_MS, this._graceMs() / 2);
  },

  /**
   * Time left before the session is ended.
   *
   * @returns {number}
   */
  _remainingGraceMs() {
    return Math.max(0, this._graceMs() - (Date.now() - this._outageStartedAt));
  },

  /**
   * Arms the timer for the next warning update or the deadline, whichever
   * comes first.
   */
  _scheduleGraceTimer() {
    this._cancelVerification();
    const remainingMs = this._remainingGraceMs();
    lazy.log.debug(
      `Console unreachable; ${remainingMs}ms remain in network-loss grace period.`
    );
    if (this._timer !== null) {
      lazy.clearTimeout(this._timer);
    }
    // Wake for whichever comes first, the next warning update or the deadline.
    const nextWakeMs = Math.min(remainingMs, this._msUntilWarningUpdate());
    this._timer = lazy.setTimeout(() => this._onGraceTimer(), nextWakeMs);
  },

  /**
   * How long until the warning has something new to say: the end of the
   * debounce the first bar waits out, the escalation to the imminent phase,
   * then every minute the imminent bar counts off. Infinity once nothing is
   * left to say before the deadline itself.
   *
   * @returns {number}
   */
  _msUntilWarningUpdate() {
    const elapsedMs = Date.now() - this._outageStartedAt;
    const debounceMs = this._warningDebounceMs();
    if (elapsedMs < debounceMs) {
      return debounceMs - elapsedMs;
    }
    const remainingMs = this._remainingGraceMs();
    const untilImminentMs = remainingMs - IMMINENT_THRESHOLD_MS;
    if (untilImminentMs > 0) {
      return this._warningRetryPending
        ? Math.min(untilImminentMs, WARNING_RETRY_MS)
        : untilImminentMs;
    }
    // The imminent bar names the minutes left, so it goes stale unless the
    // guard wakes for each one. The final minute cannot count any lower.
    if (remainingMs <= MS_PER_MINUTE) {
      return Infinity;
    }
    return remainingMs % MS_PER_MINUTE || MS_PER_MINUTE;
  },

  /**
   * Updates the warning, or verifies the outage once the deadline passes.
   */
  _onGraceTimer() {
    if (this._remainingGraceMs() > 0) {
      this._updateWarning();
      this._scheduleGraceTimer();
      return;
    }
    this._verifyBeforeEnforcing();
  },

  /**
   * Brings the application's warning in line with the time left, raising it
   * once the outage has outlasted the debounce.
   *
   * @returns {Promise<void>} Resolves once the delegate has applied the update.
   */
  async _updateWarning() {
    const remainingMs = this._remainingGraceMs();
    if (
      this._outageStartedAt === null ||
      this._sessionEnded ||
      this._pendingSessionEnd ||
      remainingMs <= 0 ||
      Date.now() - this._outageStartedAt < this._warningDebounceMs()
    ) {
      return;
    }
    const delegate = this._appWarningUI();
    if (!delegate) {
      lazy.log.error(
        "No network-loss warning UI is registered for this application; the user cannot be told the session is about to end."
      );
      return;
    }
    const shown = await delegate.showOrUpdate({
      phase:
        remainingMs <= IMMINENT_THRESHOLD_MS
          ? NetworkLossPhase.IMMINENT
          : NetworkLossPhase.WARNING,
      endsAt: Date.now() + remainingMs,
      minutes: Math.max(1, Math.ceil(remainingMs / MS_PER_MINUTE)),
      willLock: Services.prefs.getBoolPref(LOCKING_PREF, false),
    });
    // The console can come back, or the deadline arrive, while the delegate is
    // putting the bar up.
    if (this._outageStartedAt === null || this._sessionEnded) {
      if (shown) {
        delegate.hide();
      }
      return;
    }
    // Otherwise a warning that could not be shown waits for the imminent
    // phase, hours away with the default grace period.
    this._warningRetryPending = !shown;
    if (!shown && !this._pendingSessionEnd && this._remainingGraceMs() > 0) {
      this._scheduleGraceTimer();
    }
  },

  /**
   * The application's warning UI, loading it from WARNING_UI_CATEGORY the first
   * time one is asked for. Resolving it here rather than at startup keeps the
   * delegate's module out of the browser's startup path, since most sessions
   * never lose the console.
   *
   * @returns {object|null} The delegate, or null if the application has none.
   */
  _appWarningUI() {
    if (this._warningUIDelegate || this._warningUILoaded) {
      return this._warningUIDelegate;
    }
    this._warningUILoaded = true;
    this._registerFromCategory(
      WARNING_UI_CATEGORY,
      "registerNetworkLossWarningUI"
    );
    return this._warningUIDelegate;
  },

  /**
   * The application's lock intent delegate, loading it from
   * LOCK_INTENT_CATEGORY the first time one is asked for, which only happens
   * when ending the session has failed.
   *
   * @returns {object|null} The delegate, or null if the application has none.
   */
  _appLockIntents() {
    if (this._lockIntentDelegate || this._lockIntentLoaded) {
      return this._lockIntentDelegate;
    }
    this._lockIntentLoaded = true;
    this._registerFromCategory(
      LOCK_INTENT_CATEGORY,
      "registerNetworkLossLockIntentDelegate"
    );
    return this._lockIntentDelegate;
  },

  /**
   * Calls the named registration function exported by each module listed in
   * the category.
   *
   * @param {string} aCategory - The category listing the module URLs.
   * @param {string} aEntryPoint - The registration function each module exports.
   * @returns {void}
   */
  _registerFromCategory(aCategory, aEntryPoint) {
    for (const { value: url } of Services.catMan.enumerateCategory(aCategory)) {
      try {
        ChromeUtils.importESModule(url)[aEntryPoint]();
      } catch (e) {
        lazy.log.error(`Failed to call ${aEntryPoint}() from ${url}:`, e);
      }
    }
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
   * Forwards a reachability result from FELT to the browser it manages.
   *
   * @param {boolean} reachable
   */
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
   * Ends the outage: hides the warning and cancels its timers and observers.
   */
  _clearOutage() {
    this._cancelVerification();
    this._warningRetryPending = false;
    this._warningUIDelegate?.hide();
    if (this._timer !== null) {
      lazy.clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._outageStartedAt !== null) {
      Services.prefs.removeObserver(ENABLED_PREF, this);
      Services.prefs.removeObserver(GRACE_PERIOD_PREF, this);
      Services.prefs.removeObserver(LOCKING_PREF, this);
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
      if (Services.startup.shuttingDown) {
        return true;
      }
      const lockIntents = this._appLockIntents();
      if (lockIntents) {
        lockIntents.restoreLockIntents();
      } else {
        lazy.log.error(
          "No lock intent delegate is registered; the NetworkLoss intent stays in place for the next shutdown."
        );
      }
      return false;
    }
  },

  /**
   * Forces the browser to quit after the session was ended, retrying until
   * shutdown begins.
   *
   * @returns {Promise<void>}
   */
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
    if (!Services.prefs.getBoolPref(ENABLED_PREF, false)) {
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
