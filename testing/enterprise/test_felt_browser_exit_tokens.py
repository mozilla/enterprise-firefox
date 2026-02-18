#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys
import time

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class BrowserExitTokens(FeltTests):
    def test_browser_exit_tokens(self):
        self.felt_block_shutdown()
        super().run_felt_base()
        self.run_browser_set_fake_tokens()
        self.perform_quit()
        self.await_felt_auth_window()
        self.force_window()
        self.run_felt_check_fake_tokens()

    def felt_block_shutdown(self):
        self._driver.set_context("chrome")
        self._driver.execute_script(
            """
            Services.prefs.setBoolPref("enterprise.felt_tests.is_blocking_shutdown", true);
            """
        )
        self._driver.set_context("content")

    def perform_quit(self):
        self._child_driver.set_context("chrome")
        rv = self._child_driver.execute_script(
            """
            Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
            """,
        )
        self._child_driver.set_context("content")
        self._manually_closed_child = True
        return rv

    def get_tokens(self, driver):
        driver.set_context("chrome")
        rv = driver.execute_script(
            """
            return [ Services.felt.getAccessTokenIfValid(), Services.felt.getRefreshToken() ];
            """,
        )
        driver.set_context("content")
        return rv

    def run_browser_set_fake_tokens(self):
        self.connect_child_browser()

        browser_tokens = self.get_tokens(self._child_driver)

        self.access_token = "1bf8d2cb-9f72-4788-a770-3cf9cc60f30c"
        self.refresh_token = "82b2d9eb-f0e3-44af-8106-790e7a744d1f"
        self.expires_at = int(time.time()) + 3600

        assert browser_tokens[0] != self.access_token, (
            f"Access token differs: {browser_tokens[0]} vs {self.access_token}"
        )
        assert browser_tokens[1] != self.refresh_token, (
            f"Refresh token differs: {browser_tokens[1]} vs {self.refresh_token}"
        )

        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            """
            Services.felt.setTokens(arguments[0], arguments[1], arguments[2]);
            """,
            [self.access_token, self.refresh_token, self.expires_at],
        )
        self._child_driver.set_context("content")

    def run_felt_check_fake_tokens(self):
        felt_tokens_after_signout = self.get_tokens(self._driver)
        assert felt_tokens_after_signout[0] == self.access_token, (
            f"Access token matches: {felt_tokens_after_signout[0]} vs {self.access_token}"
        )
        assert felt_tokens_after_signout[1] == self.refresh_token, (
            f"Refresh token matches: {felt_tokens_after_signout[1]} vs {self.refresh_token}"
        )
