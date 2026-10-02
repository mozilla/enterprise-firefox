#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import json
import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_relaunch_deadline import (
    IMMINENT_ID,
    WARNING_ID,
    BrowserRelaunchDeadlineBase,
)


class BrowserRelaunchDeadlineRestart(BrowserRelaunchDeadlineBase):
    """The console drives the restart deadline through the policy poll.

    Covers the two ends of the contract: a comfortable budget warns the user,
    and an exhausted budget with no grace left restarts the browser.
    """

    def test_relaunch_deadline_warns_then_restarts(self):
        self.run_felt_base()
        self.connect_child_browser()
        browser_pid = self._child_driver.session_capabilities["moz:processID"]

        self._logger.info("Console starts asking for a restart within the hour")
        self.serve_relaunch({"MinutesRemaining": 45, "HardMinutesRemaining": 180})
        assert self.wait_for_relaunch_bar() == WARNING_ID, (
            "Expected the warning bar for a comfortable restart budget"
        )

        self.assert_relaunch_message(
            "enterprise-relaunch-warning-message", "will restart at"
        )

        self._logger.info("Console tightens the budget past the escalation threshold")
        # A zero grace period lets the soft budget govern this seconds-old warning.
        self.serve_relaunch({"MinutesRemaining": 4, "GracePeriodMinutes": 0})
        self._child_wait.until(
            lambda _: self.relaunch_bar() == IMMINENT_ID,
            message="The warning did not escalate as the deadline approached",
        )

        self.assert_relaunch_message(
            "enterprise-relaunch-imminent-message", "will restart in 4 minutes"
        )

        self._logger.info("Console leaves seconds on the clock")
        # A grace period is measured from when the deadline first arrived, so
        # every poll re-derives the same deadline and the armed timer is what
        # restarts. Ten seconds of it are left once this poll lands.
        grace = (self.grace_age_ms() + 10_000) / 60_000
        self.serve_relaunch({"MinutesRemaining": 0, "GracePeriodMinutes": grace})
        assert self.enforcer_state()["restartArmed"], (
            "Expected the restart to be waiting on a timer"
        )

        # Keep the successor from consuming the old session's short grace while
        # the server switches budgets across the restart.
        self.policies_omit_policies.value = 1
        try:
            self.wait_process_exit(browser_pid)
            self.relaunch.value = json.dumps({"MinutesRemaining": 0})
        finally:
            self.policies_omit_policies.value = 0

        self._logger.info("Connecting to the relaunched browser")
        self.connect_child_browser()
        new_browser_pid = self._child_driver.session_capabilities["moz:processID"]
        assert new_browser_pid != browser_pid, (
            f"Expected a new process, still {new_browser_pid}"
        )

        assert self.wait_for_relaunch_bar() == WARNING_ID, (
            "Expected the fresh session to warn for the length of its grace period"
        )
        state = self.enforcer_state()
        assert state["schedule"]["restartAt"] - state["graceStart"] == 10 * 60 * 1000, (
            f"Expected the default ten minute grace period, got {state}"
        )
        self.serve_relaunch({"MinutesRemaining": 0})
        assert self.process_alive(new_browser_pid), (
            "The grace period did not keep the fresh session running"
        )

    def enforcer_state(self):
        """The armed deadline.

        testingOnly_getState() is gated on Cu.isInAutomation, which is off in a
        Marionette-driven browser.
        """
        self._child_driver.set_context("chrome")
        return self._child_driver.execute_script(
            """
            const { RelaunchEnforcer } = ChromeUtils.importESModule(
              "resource://gre/modules/enterprise/RelaunchEnforcer.sys.mjs"
            );
            return {
                schedule: RelaunchEnforcer._schedule,
                graceStart: RelaunchEnforcer._graceStart,
                restartArmed: !!RelaunchEnforcer._restartTask?.isArmed,
            };
            """
        )

    def grace_age_ms(self):
        self._child_driver.set_context("chrome")
        return self._child_driver.execute_script(
            """
            const { RelaunchEnforcer } = ChromeUtils.importESModule(
              "resource://gre/modules/enterprise/RelaunchEnforcer.sys.mjs"
            );
            return Date.now() - RelaunchEnforcer._graceStart;
            """
        )

    def process_alive(self, pid):
        import psutil

        return psutil.pid_exists(pid)
