#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_browser_starts import FeltStartsBrowser


class BrowserShutdownCrash(FeltStartsBrowser):
    def test_browser_shutdown_crash(self):
        super().run_felt_base()
        self.run_felt_browser_started()
        self.run_force_shutdown_timeout()
        self.run_force_quit()

    def run_force_shutdown_timeout(self):
        self._child_driver.set_context("chrome")
        self._logger.info("Forcing async shutdown pref to low value")
        self._child_driver.execute_script(
            """
            Services.prefs.setIntPref(arguments[0], arguments[1]);
            Services.prefs.setIntPref(arguments[2], arguments[3]);
            """,
            # 100ms should be enough to allow the code to trigger the observer
            # quit-application:shutdown, and still make us crash for async
            # shutdown timeout
            [
                "toolkit.asyncshutdown.crash_timeout",
                100,
                "toolkit.asyncshutdown.crash_timeout_additional_wait",
                0,
            ],
        )
        self._child_driver.set_context("content")

    def run_force_quit(self):
        self._manually_closed_child = True

        self._child_driver.set_context("chrome")

        self._logger.info("Trigger quit, expected to crash")
        self._browser_pid = self._child_driver.session_capabilities["moz:processID"]
        try:
            self._child_driver.execute_script(
                "Services.startup.quit(Ci.nsIAppStartup.eForceQuit);"
            )
        except Exception:
            pass

        self.wait_process_exit()
        try:
            self._logger.info("Trying to connect to new browser")
            self.connect_child_browser()
            new_browser_pid = self._child_driver.session_capabilities["moz:processID"]
            assert self._browser_pid != new_browser_pid, (
                f"PID should not be the same: {self._browser_pid} != {new_browser_pid}"
            )
            assert new_browser_pid is None, (
                f"Should not have started a new browser: {new_browser_pid}"
            )
            assert False, (
                "Connected to a new child browser, shutdown crash should not trigger a restart"
            )
        except FileNotFoundError:
            self._logger.info("Trying to connect to new browser failed")
            assert True, "Shutdown crash did not trigger a browser restart"
