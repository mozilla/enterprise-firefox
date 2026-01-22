#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import sys

from felt_browser_crashes import BrowserCrashes


class BrowserCrashAbortRestart(BrowserCrashes):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def test_felt_2_crash_parent_once(self, exp):
        self.connect_and_crash()
        return True

    def test_felt_3_proper_restart(self, exp):
        self.wait_process_exit()
        self._logger.info("Connecting to new browser")
        self.connect_child_browser()
        self._browser_pid = self._child_driver.capabilities["moz:processID"]
        self._logger.info(f"Connected to {self._browser_pid}")
        self.open_tab_child("about:support")

        version_box = self.get_elem_child("#version-box")
        self._child_wait.until(lambda d: len(version_box.text) > 0)
        return True

    def test_felt_4_crash_parent_twice(self, exp):
        self._manually_closed_child = True
        self.crash_parent()
        return True

    def test_felt_5_check_error_message(self, exp):
        self.await_felt_auth_window()
        self.force_window()

        self._driver.set_context("chrome")
        self._logger.info("Checking for error message")

        error_msg = self.get_elem(".felt-browser-error-multiple-crashes")
        assert "crashed multiple times" in error_msg.text, "Error message about crashes"

        return True


if __name__ == "__main__":
    BrowserCrashAbortRestart(
        "felt_browser_crash_abort_restart.json",
        firefox=sys.argv[1],
        geckodriver=sys.argv[2],
        profile_root=sys.argv[3],
        env_vars={"MOZ_FELT_UI": "1", "MOZ_GDB_SLEEP": "1"},
        test_prefs=[
            ["enterprise.browser.abnormal_exit_limit", 2],
            ["enterprise.browser.abnormal_exit_period", 120],
        ],
    )
