#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys
import time

import psutil
from felt_tests import FeltTests
from selenium.common.exceptions import NoSuchWindowException, WebDriverException


class BrowserRestartWorks(FeltTests):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def test_felt_3_perform_restart(self, exp):
        self._logger.info("Connecting to browser")
        self.connect_child_browser()
        self._browser_pid = self._child_driver.capabilities["moz:processID"]
        self._logger.info(f"Connected to {self._browser_pid}")

        try:
            self._logger.info("Issuing restart, expecting restart being done by felt")
            self._child_driver.set_context("chrome")
            self._child_driver.execute_script(
                "Services.startup.quit(Ci.nsIAppStartup.eRestart | Ci.nsIAppStartup.eAttemptQuit);"
            )
        except WebDriverException:
            self._logger.info("Received expected WebDriverException")
        except NoSuchWindowException:
            self._logger.info("Received expected NoSuchWindowException")
        finally:
            self._logger.info(
                f"Issued restart, expecting quit underway, checking PID {self._browser_pid}"
            )
            self._manually_closed_child = True

        return True

    def test_felt_4_restart_new_process(self, exp):
        self._logger.info("Waiting a few seconds ...")
        if sys.platform == "win32":
            time.sleep(8)
        else:
            time.sleep(3)
        self._logger.info(f"Checking PID {self._browser_pid}")

        if not psutil.pid_exists(self._browser_pid):
            self._logger.info(f"No more PID {self._browser_pid}")
        else:
            try:
                process = psutil.Process(pid=self._browser_pid)
                process_name = process.name()
                process_exe = process.exe()
                process_basename = os.path.basename(process_name)
                process_cmdline = process.cmdline()
                self._logger.info(
                    f"Found PID {self._browser_pid}: EXE:{process_exe} :: NAME:{process_name} :: CMDLINE:{process_cmdline} :: BASENAME:'{process_basename}'"
                )
                assert process_basename != "firefox", "Process is not Firefox"
            except psutil.ZombieProcess:
                self._logger.info(f"Zombie found as {self._browser_pid}")
                return True

        self._logger.info("Connecting to new browser")
        self.connect_child_browser()
        new_browser_pid = self._child_driver.capabilities["moz:processID"]
        self._logger.info(f"Connected to new brower with PID {new_browser_pid}")

        self._logger.info(
            f"Checking PID changes from {self._browser_pid} to {new_browser_pid}"
        )
        assert (
            new_browser_pid != self._browser_pid
        ), f"PID changed from {self._browser_pid} to {new_browser_pid}"

        self._logger.info(f"Closing new browser with PID {new_browser_pid}")
        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            "Services.startup.quit(Ci.nsIAppStartup.eForceQuit);"
        )

        return True


if __name__ == "__main__":
    BrowserRestartWorks(
        "felt_browser_restart_works.json",
        firefox=sys.argv[1],
        geckodriver=sys.argv[2],
        profile_root=sys.argv[3],
        env_vars={"MOZ_FELT_UI": "1"},
    )
