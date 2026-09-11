/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
  InfoBar: "resource:///modules/asrouter/InfoBar.sys.mjs",
  ScheduledTask: "resource://gre/modules/ScheduledTask.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("RelaunchEnforcer");
});

const MS_PER_MINUTE = 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 5 * MS_PER_MINUTE;

// Grace granted to a freshly launched session when the console names none.
const DEFAULT_GRACE_PERIOD_MINUTES = 10;

// How close to the deadline the warning escalates to the imminent phase.
const IMMINENT_THRESHOLD_MS = 5 * MS_PER_MINUTE;

// The longest budget the contract supports. nsITimer takes a 32-bit millisecond
// delay, so a wait past 2^32 - 1 ms, about 49.7 days, wraps and fires early.
const MAX_BUDGET_MINUTES = 30 * 24 * 60;

const WARNING_ID = "ENTERPRISE_RELAUNCH_WARNING";
const IMMINENT_ID = "ENTERPRISE_RELAUNCH_IMMINENT";

// InfoBar serves one message at a time, and yields the slot only to a message
// naming the incumbent. These are the in-tree infobar messages; a message from
// Nimbus or Remote Settings holds the slot until the next poll retries. Keep it
// in step with the ids the in-tree message providers author.
const REPLACEABLE_IDS = [
  WARNING_ID,
  IMMINENT_ID,
  "COMPULSORY_RESTART_SCHEDULED",
  "INFOBAR_ACTION_86",
  "INFOBAR_DEFAULT_AND_PIN_87",
  "INFOBAR_LAUNCH_ON_LOGIN",
  "INFOBAR_LAUNCH_ON_LOGIN_FINAL",
  "MULTIPROFILE_DATA_COLLECTION_CHANGED_INFOBAR",
  "PREF_OBSERVER_MESSAGE_94",
  "updated-privacy-notice-notification-infobar",
];

/**
 * Enforces the restart deadline the enterprise console reports on each policy
 * poll: warns the user, and force-restarts when the deadline arrives.
 */
export const RelaunchEnforcer = {
  _schedule: null,
  _lastUpdateCheck: null,
  _restartTask: null,
  _escalationTask: null,
  _countdownTask: null,
  _notification: null,
  _shownPhase: null,
  _shownMinutes: null,
  _shownDeadlineMinute: null,
  _restarting: false,
  _awaitingSessionRestore: false,
  // Serializes bar updates against the shown-state above.
  _refreshChain: Promise.resolve(),

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
    if (
      this._lastUpdateCheck === null ||
      now - this._lastUpdateCheck >= UPDATE_CHECK_INTERVAL_MS ||
      now < this._lastUpdateCheck
    ) {
      try {
        this._requestUpdateCheck();
        this._lastUpdateCheck = now;
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
    lazy.ConsoleClient.quitIgnoringCanClose(
      Ci.nsIAppStartup.eForceQuit | Ci.nsIAppStartup.eRestart
    );
  },

  /**
   * Brings the warning bar in line with the armed deadline, touching the UI only
   * when the text the user reads changes.
   *
   * @returns {Promise<void>} Resolves once this update has been applied.
   */
  _refreshNotification() {
    // Failures stay out of the chain.
    this._refreshChain = this._refreshChain
      .then(() => this._updateBar())
      .catch(e => lazy.log.error("Failed to update the relaunch warning:", e));
    return this._refreshChain;
  },

  async _updateBar() {
    if (!this._schedule || this._restarting) {
      return;
    }

    const win = this._barWindow();
    if (!win) {
      // The first poll precedes session restore; the next poll retries.
      return;
    }

    const { restartAt } = this._schedule;
    const remaining = restartAt - Date.now();
    const isImminent = remaining <= IMMINENT_THRESHOLD_MS;
    const phase = isImminent ? IMMINENT_ID : WARNING_ID;
    const minutes = Math.max(1, Math.ceil(remaining / MS_PER_MINUTE));
    const deadlineMinute = Math.floor(restartAt / MS_PER_MINUTE);

    if (this._isBarShown() && phase === this._shownPhase) {
      const sameText = isImminent
        ? minutes === this._shownMinutes
        : deadlineMinute === this._shownDeadlineMinute;
      // Updating the bar already up keeps focus on its button. It also keeps a
      // re-show under an id InfoBar is still tracking off the table, which
      // would leave the new bar out of its bookkeeping and unremovable.
      if (
        sameText ||
        this._setBarVariable(
          phase,
          isImminent ? "minutes" : "datetime",
          isImminent ? minutes : restartAt
        )
      ) {
        this._shownMinutes = minutes;
        this._shownDeadlineMinute = deadlineMinute;
        if (isImminent) {
          this._armCountdown(minutes);
        }
        return;
      }
    }

    const message = {
      id: phase,
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
          this._restart();
        }
      }
    );

    if (!notification) {
      // The restart still lands on schedule, so say who kept the warning off.
      lazy.log.warn(
        `The infobar slot is held by ${lazy.InfoBar._activeInfobar?.message?.id}; the relaunch warning is not shown.`
      );
      return;
    }

    if (!this._schedule) {
      // The console withdrew the deadline while the bar was going up. A later
      // poll queues behind this one on _refreshChain, so it reconciles the text.
      if (lazy.InfoBar._activeInfobar?.notification === notification) {
        notification.removeUniversalInfobars();
      }
      return;
    }

    this._notification = notification;
    this._shownPhase = phase;
    this._shownMinutes = minutes;
    this._shownDeadlineMinute = deadlineMinute;

    if (isImminent) {
      this._armCountdown(minutes);
    }
  },

  /**
   * The window to show the warning from. The most recent window can be a
   * private window, a popup or a taskbar tab, and InfoBar refuses all of those.
   *
   * InfoBar is only reached once a window exists, so the first poll does not
   * drag its module graph into "policies-startup".
   *
   * @returns {Window|null} null when no open window can take a bar.
   */
  _barWindow() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (
        win.gBrowser &&
        // TODO(Bug 2066128): Remove once InfoBar handles loading windows.
        win.document.readyState === "complete" &&
        lazy.InfoBar.isValidInfobarWindow(win)
      ) {
        return win;
      }
    }
    return null;
  },

  /**
   * Puts a new value in one Fluent variable of the bars that are up, in every
   * window.
   *
   * @param {string} barId - The id of the bar to update.
   * @param {string} name - The Fluent variable name.
   * @param {string|number} value - The value to substitute.
   * @returns {boolean} Whether a bar took the new value.
   */
  _setBarVariable(barId, name, value) {
    let updated = false;
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const bar = win.gNotificationBox?.getNotificationWithValue(barId);
      const remote = bar?.querySelector("remote-text");
      if (remote) {
        remote.setVariable(name, value);
        updated = true;
      }
    }
    if (updated) {
      // A window opened from here on is served the stored message, not the DOM.
      const { attributes } =
        lazy.InfoBar._activeInfobar?.message?.content ?? {};
      if (attributes) {
        attributes[name] = value;
      }
    }
    return updated;
  },

  // InfoBar hands the slot to another message, and closing the last window on
  // macOS takes the bar with it.
  _isBarShown() {
    return (
      !!this._notification &&
      lazy.InfoBar._activeInfobar?.notification === this._notification
    );
  },

  _hideNotification() {
    // A bar InfoBar lost track of is not in the list removeUniversalInfobars()
    // walks, so take ours out of each window by hand. Skipping the animation
    // removes the element, and runs InfoBar's own teardown, before returning.
    let removed = false;
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const id of [WARNING_ID, IMMINENT_ID]) {
        const bar = win.gNotificationBox?.getNotificationWithValue(id);
        if (bar) {
          win.gNotificationBox.removeNotification(bar, true);
          removed = true;
        }
      }
    }
    // Releases the slot, and the new-window observer, InfoBar may still hold.
    if (removed || this._isBarShown()) {
      this._notification?.removeUniversalInfobars();
    }
    this._notification = null;
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
      barShown: this._isBarShown(),
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
    this._disarm();
    this._stopAwaitingSessionRestore();
    this._hideNotification();
    this._restarting = false;
  },
};
