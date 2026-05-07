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
        self.run_felt_base()
        self.connect_child_browser()
        self.check_felt_and_firefox_tokens_in_sync()
        self.force_and_refresh_tokens()
        self.check_firefox_tokens_updated_after_session_refresh()

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
        # browser should not have the refresh token
        assert self.browser_tokens[1] == "", (
            "Browser refresh token should be empty: " + self.browser_tokens[1]
        )
        assert self.felt_tokens[1] != "", (
            "Felt refresh token should not be empty: " + self.felt_tokens[1]
        )

    def check_firefox_tokens_updated_after_session_refresh(self):
        self.new_browser_tokens = self.get_tokens(Environment.FIREFOX)
        self.new_felt_tokens = self.get_tokens(Environment.FELT)
        assert len(self.new_browser_tokens[0]) > 0, (
            "Browser access token should not be empty"
        )
        assert len(self.new_browser_tokens[1]) == 0, (
            "Browser refresh token should be empty"
        )
        assert self.new_browser_tokens[0] != self.browser_tokens[0], (
            f"Browser access token should differ after session refresh: {self.new_browser_tokens[0]} vs {self.browser_tokens[0]}"
        )
        assert self.new_felt_tokens[0] != self.felt_tokens[0], (
            f"Felt access token should differ after session refresh: {self.new_felt_tokens[0]} vs {self.felt_tokens[0]}"
        )
        assert self.new_felt_tokens[1] != self.felt_tokens[1], (
            f"Felt refresh token should differ after session refresh: {self.new_felt_tokens[1]} vs {self.felt_tokens[1]}"
        )
