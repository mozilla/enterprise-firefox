#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_browser_crashes import BrowserCrashes


class BrowserCrashAbortRestart(BrowserCrashes):
    EXTRA_PREFS = {
        "enterprise.browser.abnormal_exit_limit": 2,
        "enterprise.browser.abnormal_exit_period": 120,
    }

    def test_browser_crash_abort_restart(self):
        super().run_felt_base()
        self.run_felt_crash_parent_once()
        self.run_felt_proper_restart()
        self.run_felt_crash_parent_twice()
        self.run_felt_check_error_message()

    def run_felt_check_error_message(self):
        self.await_felt_auth_window()
        self.force_window()

        self._driver.set_context("chrome")
        self._logger.info("Checking for error message")

        error_msg = self.get_elem(".felt-browser-error-multiple-crashes")
        assert "crashed multiple times" in error_msg.text, "Error message about crashes"
