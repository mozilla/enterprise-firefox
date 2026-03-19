#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests


class BrowserExitTokens(FeltTests):
    def test_browser_exit_tokens(self):
        self.get_driver(Environment.FELT).set_prefs(
            # required to not close felt window when launching browser,
            # allowing to collect tokens on felt side
            {
                "enterprise.felt_tests.should_not_close_window": True,
                "enterprise.felt_tests.is_blocking_shutdown": True,
            },
            default_branch=True,
        )
        self.assert_felt_refresh_blocked(False)
        self.run_felt_base()
        self.connect_child_browser()
        browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self.assert_felt_refresh_blocked(True)
        self.check_felt_and_firefox_tokens_in_sync()
        self.force_and_refresh_tokens()
        self.check_firefox_tokens_updated_after_session_refresh()
        self.perform_quit()
        self.wait_process_exit(browser_pid)
        self.await_felt_auth_window()
        self.assert_felt_refresh_blocked(False)
        self.force_window()
        self.check_felt_received_refreshed_tokens_on_shutdown()

    def assert_felt_refresh_blocked(self, value):
        self._driver.set_context("chrome")
        refresh_blocked = self._driver.execute_script(
            """
            const { ConsoleClient } = ChromeUtils.importESModule("resource:///modules/enterprise/ConsoleClient.sys.mjs");
            return ConsoleClient.isSessionRefreshBlocked;
            """
        )
        self._driver.set_context("content")
        assert refresh_blocked == value, (
            f"Expected performing session refreshs to be {'blocked' if value else 'unblocked'} in Felt, got {'blocked' if refresh_blocked else 'unblocked'}"
        )

    def perform_quit(self):
        driver = self.get_driver(Environment.FIREFOX)
        driver.set_context("chrome")
        rv = driver.execute_script(
            """
            Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
            """,
        )
        driver.set_context("content")
        self._manually_closed_child = True
        return rv

    def get_tokens(self, env):
        driver = self.get_driver(env)
        driver.set_context("chrome")
        rv = driver.execute_script(
            """
            return [ Services.felt.getAccessTokenIfValid(), Services.felt.getRefreshToken() ];
            """,
        )
        driver.set_context("content")
        return rv

    def force_and_refresh_tokens(self):
        driver = self.get_driver(Environment.FIREFOX)
        driver.set_context("chrome")
        driver.execute_async_script(
            """
            const callback = arguments[arguments.length - 1];
            const { ConsoleClient } = ChromeUtils.importESModule(
                "resource:///modules/enterprise/ConsoleClient.sys.mjs"
            );
            ConsoleClient._refreshSession()
                    .then(callback)
                    .catch(err => callback({_error: String(err)}));
            """,
        )
        driver.set_context("content")

    def check_felt_and_firefox_tokens_in_sync(self):
        self.felt_tokens = self.get_tokens(Environment.FELT)
        self.browser_tokens = self.get_tokens(Environment.FIREFOX)

        assert self.felt_tokens[0] == self.browser_tokens[0], (
            f"Felt and browser access tokens should match: {self.felt_tokens[0]} vs {self.browser_tokens[0]}"
        )
        assert self.felt_tokens[1] == self.browser_tokens[1], (
            f"Felt and browser refresh tokens should match: {self.felt_tokens[1]} vs {self.browser_tokens[1]}"
        )

    def check_firefox_tokens_updated_after_session_refresh(self):
        self.new_browser_tokens = self.get_tokens(Environment.FIREFOX)
        assert len(self.new_browser_tokens[0]) > 0, (
            "Browser access token should not be empty"
        )
        assert len(self.new_browser_tokens[1]) > 0, (
            "Browser refresh token should not be empty"
        )

        assert self.new_browser_tokens[0] != self.browser_tokens[0], (
            f"Browser access token should differ after session refresh: {self.new_browser_tokens[0]} vs {self.browser_tokens[0]}"
        )
        assert self.new_browser_tokens[1] != self.browser_tokens[1], (
            f"Browser refresh token should differ after session refresh: {self.new_browser_tokens[1]} vs {self.browser_tokens[1]}"
        )

    def check_felt_received_refreshed_tokens_on_shutdown(self):
        felt_tokens_after_exit = self.get_tokens(Environment.FELT)
        assert len(felt_tokens_after_exit[0]) > 0, (
            "FELT access token should not be empty"
        )
        assert len(felt_tokens_after_exit[1]) > 0, (
            "FELT refresh token should not be empty"
        )

        assert felt_tokens_after_exit[0] == self.new_browser_tokens[0], (
            f"FELT access token should match browser tokens after browser exit: {felt_tokens_after_exit[0]} vs {self.new_browser_tokens[0]}"
        )
        assert felt_tokens_after_exit[1] == self.new_browser_tokens[1], (
            f"FELT refresh token should match browser tokens after browser exit: {felt_tokens_after_exit[1]} vs {self.new_browser_tokens[1]}"
        )
