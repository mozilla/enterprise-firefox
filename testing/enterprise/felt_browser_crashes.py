#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class BrowserCrashes(FeltTests):
    EXTRA_ENV = {"MOZ_GDB_SLEEP": "1"}

    def force_window(self):
        self._driver.set_context("chrome")
        assert len(self._driver.chrome_window_handles) == 1, "One window exists"
        self._driver.switch_to_window(self._driver.chrome_window_handles[0])
        self._driver.set_context("content")

    def crash_parent(self):
        self._browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._logger.info(f"Crashing browser at {self._browser_pid}")
        try:
            # This is going to trigger exception for sure
            self._logger.info("Crashing main process")
            self.open_tab_child("about:crashparent")
        except Exception as ex:
            self._logger.info(f"Caught exception {ex}")
            pass

    def connect_and_crash(self):
        self.connect_child_browser()
        self.crash_parent()

    def run_felt_crash_parent_once(self):
        self._manually_closed_child = True
        self.connect_and_crash()

    def run_felt_proper_restart(self):
        self._manually_closed_child = False
        self.wait_process_exit()
        self._logger.info("Connecting to new browser")
        self.connect_child_browser()
        self._browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._logger.info(f"Connected to {self._browser_pid}")
        self.open_tab_child("about:support")

        version_box = self.get_elem_child("#version-box")
        self._child_wait.until(lambda d: len(version_box.text) > 0)

    def run_felt_crash_parent_twice(self):
        self._manually_closed_child = True
        self.crash_parent()
