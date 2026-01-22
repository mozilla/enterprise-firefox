#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.


from felt_tests import FeltTests
from selenium.webdriver.support import expected_conditions as EC


class BrowserCrashes(FeltTests):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def record_felt_no_window(self):
        self._window_handles = self._driver.window_handles

    def await_felt_auth_window(self):
        if len(self._window_handles) == 1 and self._window_handles[0] is None:
            self._window_handles = []
        self._wait.until(EC.new_window_is_opened(self._window_handles))

    def force_window(self):
        self._driver.set_context("chrome")
        assert len(self._driver.window_handles) == 1, "One window exists"
        self._driver.switch_to.window(self._driver.window_handles[0])
        self._driver.set_context("content")

    def crash_parent(self):
        self._browser_pid = self._child_driver.capabilities["moz:processID"]
        self._logger.info(f"Crashing browser at {self._browser_pid}")
        try:
            # This is going to trigger exception for sure
            self._logger.info("Crashing main process")
            self.open_tab_child("about:crashparent")
        except Exception as ex:
            self._logger.info(f"Caught exception {ex}")
            pass

    def connect_and_crash(self):
        # Make sure we record the proper state of window handles of FELT before
        # we may re-open the window
        self.record_felt_no_window()

        self.connect_child_browser()
        self.crash_parent()
