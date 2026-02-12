#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests
from marionette_driver.errors import (
    NoSuchWindowException,
    UnknownException,
)


class BrowserRestartWorks(FeltTests):
    def test_browser_resart_works(self):
        super().run_felt_base()
        self.run_felt_perform_restart()
        self.run_felt_restart_new_process()

    def run_felt_perform_restart(self):
        self._logger.info("Connecting to browser")
        self.connect_child_browser()
        self._browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._logger.info(f"Connected to {self._browser_pid}")

        try:
            self._logger.info("Issuing restartecting restart being done by felt")
            self._child_driver.set_context("chrome")
            self._child_driver.execute_script(
                "Services.startup.quit(Ci.nsIAppStartup.eRestart | Ci.nsIAppStartup.eAttemptQuit);"
            )
        except UnknownException:
            self._logger.info("Received expected UnknownException")
        except NoSuchWindowException:
            self._logger.info("Received expected NoSuchWindowException")
        finally:
            self._logger.info(
                f"Issued restartecting quit underway, checking PID {self._browser_pid}"
            )
            self._manually_closed_child = True

    def run_felt_restart_new_process(self):
        self.wait_process_exit()
        self._logger.info("Connecting to new browser")
        self.connect_child_browser()
        new_browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._logger.info(f"Connected to new brower with PID {new_browser_pid}")

        self._logger.info(
            f"Checking PID changes from {self._browser_pid} to {new_browser_pid}"
        )
        assert new_browser_pid != self._browser_pid, (
            f"PID changed from {self._browser_pid} to {new_browser_pid}"
        )

        self._logger.info(f"Closing new browser with PID {new_browser_pid}")
        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            "Services.startup.quit(Ci.nsIAppStartup.eForceQuit);"
        )
