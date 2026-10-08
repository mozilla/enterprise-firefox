#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

import psutil
from felt_tests import FeltTests
from marionette_driver.errors import (
    NoSuchWindowException,
    UnknownException,
)


class AppRestartWorks(FeltTests):
    def test_app_restart_works(self):
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
        except OSError:
            self._logger.info(
                "Firefox quit before execute_script returned, no data received over Marionette socket"
            )
        finally:
            self._logger.info(
                f"Issued restartecting quit underway, checking PID {self._browser_pid}"
            )
            self._manually_closed_child = True

    def run_felt_restart_new_process(self):
        self.wait_process_exit(self._browser_pid)
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

        felt_ui_pid = self._driver.session_capabilities["moz:processID"]
        target_exe = psutil.Process(felt_ui_pid).exe()
        felt_browser_pids = set(self._get_felt_browser_pids(target_exe))

        assert new_browser_pid in felt_browser_pids, (
            f"Relaunched browser PID {new_browser_pid} is not running"
        )

        launcher_pid = self._check_for_launcher(new_browser_pid, felt_browser_pids)

        expected_pids = {new_browser_pid}
        if launcher_pid is not None:
            expected_pids.add(launcher_pid)

        unexpected = felt_browser_pids - expected_pids
        assert not unexpected, (
            f"Extra FELT browser process(es) after restart (double relaunch?): {unexpected}"
        )

        self._logger.info(f"Closing new browser with PID {new_browser_pid}")
        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            "Services.startup.quit(Ci.nsIAppStartup.eForceQuit);"
        )

    def _get_felt_browser_pids(self, target_exe):
        pids = []
        for proc in psutil.process_iter(["pid", "exe", "cmdline"]):
            try:
                cmdline = proc.info["cmdline"] or []
                # Check for FELT browser process with -felt.
                if proc.info["exe"] == target_exe and "-felt" in cmdline:
                    pids.append(proc.info["pid"])
            except (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied):
                continue
        return pids

    def _check_for_launcher(self, browser_pid, felt_browser_pids):
        """On Windows Firefox, asserts that browser_pid was started by a
        launcher process, and returns that launcher's PID.
        Otherwise returns None.
        """
        app_name = self._driver.session_capabilities.get("browserName")
        if sys.platform != "win32" or app_name != "firefox":
            return None

        launcher_pid = self._get_launcher_pid(browser_pid)
        assert launcher_pid in felt_browser_pids, (
            f"Expected a launcher process parent for browser PID {browser_pid}, "
            f"got {launcher_pid}; running FELT browser processes: "
            f"{felt_browser_pids}"
        )
        return launcher_pid

    def _get_launcher_pid(self, browser_pid):
        """Returns the browser's parent process PID if it is a launcher
        process (i.e., the command line contains "--launcher" and "-felt").
        Returns None when the browser has no launcher.
        """
        try:
            parent = psutil.Process(browser_pid).parent()
            if parent:
                cmdline = parent.cmdline()
                if "--launcher" in cmdline and "-felt" in cmdline:
                    return parent.pid
        except (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied):
            pass
        return None
