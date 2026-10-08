/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  ForcedQuitHandler:
    "resource://gre/modules/enterprise/ForcedQuitHandler.sys.mjs",
  ScheduledTask: "resource://gre/modules/ScheduledTask.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("RelaunchEnforcer");
});

const MS_PER_MINUTE = 60 * 1000;
// Retries after the first update check of a directive double from this spacing
// up to app.update.interval.
const UPDATE_CHECK_INTERVAL_MS = 5 * MS_PER_MINUTE;

// Grace granted to a freshly launched session when the console names none.
const DEFAULT_GRACE_PERIOD_MINUTES = 10;

// How close to the deadline the warning escalates to the imminent phase.
const IMMINENT_THRESHOLD_MS = 5 * MS_PER_MINUTE;

// The application provides its warning UI through this category. An entry's
// value is the URL of a module exporting registerRelaunchWarningUI(). Nothing
// instantiates the category, so the module loads only when a warning is due.
const WARNING_UI_CATEGORY = "enterprise-relaunch-warning-ui";

// The longest budget the contract supports. nsITimer takes a 32-bit millisecond
// delay, so a wait past 2^32 - 1 ms, about 49.7 days, wraps and fires early.
const MAX_BUDGET_MINUTES = 30 * 24 * 60;

/**
 * The phases a warning UI delegate's showOrUpdate() can be asked to present.
 */
export const RelaunchPhase = Object.freeze({
  WARNING: "warning",
  IMMINENT: "imminent",
});

/**
 * Enforces the restart deadline the enterprise console reports on each policy
 * poll: warns the user through the application's warning UI delegate, and
 * force-restarts when the deadline arrives.
 */
export const RelaunchEnforcer = {
  _schedule: null,
  _lastUpdateCheck: null,
  _updateCheckDelay: UPDATE_CHECK_INTERVAL_MS,
  _restartTask: null,
  _escalationTask: null,
  _countdownTask: null,
  _shownPhase: null,
  _shownMinutes: null,
  _shownDeadlineMinute: null,
  _restarting: false,
  _awaitingSessionRestore: false,
  // Serializes bar updates against the shown-state above.
  _refreshChain: Promise.resolve(),
  // Delegate the warning UI to the application, loaded on first use.
  _warningUIDelegate: null,
  _warningUILoaded: false,

  /**
   * Registers application-specific relaunch warning UI. Only one delegate can
   * be registered for the lifetime of the application.
   *
   * `showOrUpdate` receives the warning phase, deadline, remaining minutes, and
   * a callback for the warning's restart action. It reports whether a warning
   * is visible after the update. `hide` must remove any warning even when
   * `isVisible` returns false, and must tolerate repeated calls for the same
   * withdrawal.
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
    if (this._schedule && !this._restarting) {
      this._refreshNotification();
    }
  },

  get _sessionStart() {
    // The real process start.
    return Services.startup.getStartupInfo().process.getTime();
  },

  /**
   * Derives the deadline this session must restart by, from the budget the
   * console reported on a poll.
   *
   * The console sends the time remaining and re-sends it every poll, so this
   * derives the deadline afresh from the local clock each time.
   *
   * A budget the console reports as already spent is negative, and means the
   * session is overdue. A negative grace period is not a budget but a nonsense
   * bound, and is rejected with the rest of a payload that fails to parse.
   *
   * @param {object} options
   * @param {number} [options.now=Date.now()] - When the budget arrived, in epoch
   *   ms.
   * @param {number} [options.sessionStart] - Epoch ms this process started.
   *   Defaults to this process's start.
   * @param {object|null} options.params - The console's `relaunch` payload.
   * @returns {{restartAt: number}|null} null means nothing is pending.
   */
  _computeRestartTime({
    now = Date.now(),
    sessionStart = this._sessionStart,
    params,
  }) {
    if (!params || typeof params !== "object") {
      return null;
    }

    const { MinutesRemaining, HardMinutesRemaining, GracePeriodMinutes } =
      params;
    if (!Number.isFinite(MinutesRemaining)) {
      return null;
    }

    // An omitted optional field takes its default. A value that fails to parse
    // means nothing here can be trusted, and restarting risks the user's work.
    const hardOmitted = HardMinutesRemaining == null;
    if (!hardOmitted && !Number.isFinite(HardMinutesRemaining)) {
      return null;
    }
    const graceOmitted = GracePeriodMinutes == null;
    if (
      !graceOmitted &&
      (!Number.isFinite(GracePeriodMinutes) || GracePeriodMinutes < 0)
    ) {
      return null;
    }

    const softMinutes = Math.min(MinutesRemaining, MAX_BUDGET_MINUTES);
    // A hard deadline is at least the soft deadline.
    const hardAt = hardOmitted
      ? null
      : now +
        Math.min(
          Math.max(HardMinutesRemaining, MinutesRemaining),
          MAX_BUDGET_MINUTES
        ) *
          MS_PER_MINUTE;
    const graceMinutes = Math.min(
      graceOmitted ? DEFAULT_GRACE_PERIOD_MINUTES : GracePeriodMinutes,
      MAX_BUDGET_MINUTES
    );

    const softAt = now + softMinutes * MS_PER_MINUTE;
    const graceEnd = sessionStart + graceMinutes * MS_PER_MINUTE;

    // The grace period floors the deadline, a hard deadline caps it.
    return {
      restartAt: Math.min(hardAt ?? Infinity, Math.max(softAt, graceEnd)),
    };
  },

  // Recorded when "sessionstore-windows-restored" fires, so this also answers
  // for a session that was already restored before this module was loaded.
  get _sessionRestored() {
    return "sessionRestored" in Services.startup.getStartupInfo();
  },

  /**
   * Applies one poll's worth of the console's restart budget, changed or not, so
   * the deadline re-derives across a suspend, a clock jump or a missed timer.
   *
   * @param {object|null} relaunch - The response's `relaunch` key, if any.
   */
  onConsolePoll(relaunch) {
    if (this._restarting) {
      return;
    }

    const schedule = this._computeRestartTime({ params: relaunch });

    if (!schedule) {
      if (relaunch) {
        lazy.log.error(
          `Ignoring malformed relaunch budget: ${JSON.stringify(relaunch)}`
        );
      }
      this.cancel();
      return;
    }

    const now = Date.now();
    const isRetry = this._lastUpdateCheck !== null;
    if (
      !isRetry ||
      now - this._lastUpdateCheck >= this._updateCheckDelay ||
      now < this._lastUpdateCheck
    ) {
      try {
        this._requestUpdateCheck();
        this._lastUpdateCheck = now;
        if (isRetry) {
          this._updateCheckDelay = Math.min(
            this._updateCheckDelay * 2,
            Services.prefs.getIntPref("app.update.interval") * 1000
          );
        }
      } catch (e) {
        if (e.result === Cr.NS_ERROR_NOT_CONNECTED) {
          lazy.log.warn("Cannot request an update check without FELT", e);
        } else {
          lazy.log.error("Failed to request an update check from FELT", e);
        }
      }
    }
    this._schedule = schedule;
    this._arm();
    if (this._restarting) {
      return;
    }
    this._refreshNotification();
  },

  _requestUpdateCheck() {
    if (Services.felt.isFeltBrowser()) {
      Services.felt.requestUpdateCheck();
    }
  },

  /**
   * Drops a pending restart.
   */
  cancel() {
    if (!this._schedule) {
      return;
    }
    lazy.log.debug("The console withdrew the restart deadline.");
    this._schedule = null;
    this._lastUpdateCheck = null;
    this._updateCheckDelay = UPDATE_CHECK_INTERVAL_MS;
    this._disarm();
    this._stopAwaitingSessionRestore();
    this._hideNotification();
  },

  observe(aSubject, aTopic) {
    if (aTopic !== "sessionstore-windows-restored") {
      return;
    }
    this._stopAwaitingSessionRestore();
    if (this._schedule) {
      this._restart();
    }
  },

  _stopAwaitingSessionRestore() {
    if (!this._awaitingSessionRestore) {
      return;
    }
    this._awaitingSessionRestore = false;
    Services.obs.removeObserver(this, "sessionstore-windows-restored");
  },

  _arm() {
    this._disarm();

    const { restartAt } = this._schedule;
    if (restartAt <= Date.now()) {
      this._restart();
      return;
    }

    lazy.log.debug(`Restart deadline armed for ${new Date(restartAt)}.`);
    this._restartTask = new lazy.ScheduledTask(() => {
      // A fired ScheduledTask stays marked armed, so keep disarm() off it.
      this._restartTask = null;
      this._restart();
    }, restartAt).arm();

    // Polls are a minute apart, the phase boundary minute-precise.
    const escalateAt = restartAt - IMMINENT_THRESHOLD_MS;
    if (escalateAt > Date.now()) {
      this._escalationTask = new lazy.ScheduledTask(() => {
        this._escalationTask = null;
        this._refreshNotification();
      }, escalateAt).arm();
    }
  },

  _disarm() {
    this._restartTask?.disarm();
    this._restartTask = null;
    this._escalationTask?.disarm();
    this._escalationTask = null;
    this._countdownTask?.disarm();
    this._countdownTask = null;
  },

  /**
   * Arms the next countdown update from the local deadline, so the minutes the
   * bar shows stay true while the console is unreachable.
   *
   * @param {number} minutes - The minute count currently on the bar.
   */
  _armCountdown(minutes) {
    this._countdownTask?.disarm();
    this._countdownTask = null;

    if (minutes <= 1) {
      // The next tick would land on the deadline itself, where the restart is.
      return;
    }
    const nextAt = this._schedule.restartAt - (minutes - 1) * MS_PER_MINUTE;
    if (nextAt <= Date.now()) {
      return;
    }
    this._countdownTask = new lazy.ScheduledTask(() => {
      this._countdownTask = null;
      this._refreshNotification();
    }, nextAt).arm();
  },

  _restart() {
    if (this._restarting) {
      return;
    }
    // The first poll lands at "policies-startup", so an exhausted budget can
    // reach this before session restore has read the tabs the warning promised
    // would reopen. Quitting now would drop them.
    if (!this._sessionRestored) {
      if (!this._awaitingSessionRestore) {
        this._awaitingSessionRestore = true;
        Services.obs.addObserver(this, "sessionstore-windows-restored");
        lazy.log.warn(
          "Restart deadline reached before session restore; deferring."
        );
      }
      return;
    }
    this._restarting = true;
    this._disarm();
    lazy.log.warn("Restart deadline reached; restarting.");
    // eForceQuit is not forceful on its own: a page's beforeunload handler puts
    // up a dialog the user can cancel the whole restart from (bug 2039266).
    lazy.ForcedQuitHandler.quitIgnoringCanClose(
      Ci.nsIAppStartup.eForceQuit | Ci.nsIAppStartup.eRestart
    );
  },

  /**
   * Brings the warning in line with the armed deadline, touching the UI only
   * when the text the user reads changes.
   *
   * @returns {Promise<void>} Resolves once this update has been applied.
   */
  _refreshNotification() {
    // Failures stay out of the chain.
    this._refreshChain = this._refreshChain
      .then(() => this._updateDelegatedWarning())
      .catch(e => lazy.log.error("Failed to update the relaunch warning:", e));
    return this._refreshChain;
  },

  /**
   * Brings the application-provided warning in line with the armed deadline.
   *
   * @returns {Promise<void>} Resolves once the delegate has applied the update.
   */
  async _updateDelegatedWarning() {
    if (!this._schedule || this._restarting) {
      return;
    }
    const delegate = this._appWarningUI();
    if (!delegate) {
      lazy.log.error(
        "No relaunch warning UI is registered for this application; the user cannot be notified."
      );
      return;
    }
    // Every poll installs a fresh schedule, so this also catches a withdrawal
    // followed by a deadline the delegate cannot tell apart from the one it is
    // already showing.
    const schedule = this._schedule;
    const { restartAt } = schedule;
    const remaining = restartAt - Date.now();
    const isImminent = remaining <= IMMINENT_THRESHOLD_MS;
    const phase = isImminent ? RelaunchPhase.IMMINENT : RelaunchPhase.WARNING;
    const minutes = Math.max(1, Math.ceil(remaining / MS_PER_MINUTE));
    const deadlineMinute = Math.floor(restartAt / MS_PER_MINUTE);
    const sameText = isImminent
      ? minutes === this._shownMinutes
      : deadlineMinute === this._shownDeadlineMinute;

    if (delegate.isVisible() && phase === this._shownPhase && sameText) {
      this._shownMinutes = minutes;
      this._shownDeadlineMinute = deadlineMinute;
      if (isImminent) {
        this._armCountdown(minutes);
      }
      return;
    }

    const shown = await delegate.showOrUpdate({
      phase,
      restartAt,
      minutes,
      restartNow: () => {
        if (
          delegate === this._warningUIDelegate &&
          this._schedule &&
          !this._restarting
        ) {
          this._restart();
        }
      },
    });
    if (!shown) {
      return;
    }
    if (
      delegate !== this._warningUIDelegate ||
      schedule !== this._schedule ||
      this._restarting
    ) {
      delegate.hide();
      return;
    }

    this._shownPhase = phase;
    this._shownMinutes = minutes;
    this._shownDeadlineMinute = deadlineMinute;
    if (isImminent) {
      this._armCountdown(minutes);
    }
  },

  /**
   * The application's warning UI, loading it from WARNING_UI_CATEGORY the first
   * time one is asked for. Resolving it here rather than at startup keeps the
   * delegate independent of which phase the application registers from: the
   * first console poll runs at "policies-startup", ahead of any phase Firefox
   * can register from without loading these modules before profile selection.
   *
   * @returns {object|null} The delegate, or null if the application has none.
   */
  _appWarningUI() {
    if (this._warningUIDelegate || this._warningUILoaded) {
      return this._warningUIDelegate;
    }
    this._warningUILoaded = true;
    for (const { value: url } of Services.catMan.enumerateCategory(
      WARNING_UI_CATEGORY
    )) {
      try {
        ChromeUtils.importESModule(url).registerRelaunchWarningUI();
      } catch (e) {
        lazy.log.error(`Failed to register the warning UI from ${url}:`, e);
      }
    }
    return this._warningUIDelegate;
  },

  _hideNotification() {
    this._warningUIDelegate?.hide();
    this._shownPhase = null;
    this._shownMinutes = null;
    this._shownDeadlineMinute = null;
  },

  /**
   * Inspect the armed state.
   */
  testingOnly_getState() {
    if (!Cu.isInAutomation) {
      throw new Error("this method only usable in testing");
    }
    return {
      schedule: this._schedule,
      shownPhase: this._shownPhase,
      shownMinutes: this._shownMinutes,
      restartArmed: !!this._restartTask?.isArmed,
      escalationArmed: !!this._escalationTask?.isArmed,
      countdownArmed: !!this._countdownTask?.isArmed,
      barShown: !!this._warningUIDelegate?.isVisible(),
      restarting: this._restarting,
      awaitingSessionRestore: this._awaitingSessionRestore,
    };
  },

  /**
   * Tear everything down for the next test.
   */
  testingOnly_reset() {
    if (!Cu.isInAutomation) {
      throw new Error("this method only usable in testing");
    }
    this._schedule = null;
    this._lastUpdateCheck = null;
    this._updateCheckDelay = UPDATE_CHECK_INTERVAL_MS;
    this._disarm();
    this._stopAwaitingSessionRestore();
    this._hideNotification();
    this._warningUIDelegate = null;
    // Tests register the delegate they want, so leave the category alone.
    this._warningUILoaded = true;
    this._restarting = false;
  },
};
