#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests


class BrowserSignoutOnExit(FeltTests):
    """Verify that closing Firefox normally signs out the session."""

    def test_browser_signout_on_exit(self):
        self.get_driver(Environment.FELT).set_prefs(
            {
                "enterprise.felt_tests.should_not_close_window": True,
                "enterprise.felt_tests.is_blocking_shutdown": True,
            },
            default_branch=True,
        )
        self.run_felt_base()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)

        browser_pid = self._child_driver.session_capabilities["moz:processID"]

        assert self.signout_count.value == 0, "No signout should have been posted yet"

        self.perform_quit()
        self.wait_process_exit(browser_pid)
        self.await_felt_auth_window()
        self.force_window()

        assert self.signout_count.value == 1, (
            f"Expected exactly 1 signout request, got {self.signout_count.value}"
        )

        self.assert_user_signed_out(env=Environment.FELT)

    def perform_quit(self):
        driver = self.get_driver(Environment.FIREFOX)
        driver.set_context("chrome")
        driver.execute_script(
            """
            Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
            """,
        )
        try:
            driver.set_context("content")
        except OSError:
            self._logger.info(
                "Firefox quit before set_context returned, no data received over Marionette socket"
            )
        self._manually_closed_child = True
