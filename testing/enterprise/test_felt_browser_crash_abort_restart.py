#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_browser_crashes import BrowserCrashes
from felt_consts import WHOAMI_EMAIL


class BrowserCrashAbortRestart(BrowserCrashes):
    EXTRA_PREFS = {
        "enterprise.browser.abnormal_exit_limit": 2,
        "enterprise.browser.abnormal_exit_period": 120,
    }

    def _seed_stale_locking_token(self):
        driver = self.get_driver(Environment.FELT)
        driver.set_context("chrome")
        try:
            driver.execute_async_script(
                """
                const callback = arguments[arguments.length - 1];
                const { FeltStorage } = ChromeUtils.importESModule(
                    "moz-src:///toolkit/components/felt/FeltStorage.sys.mjs"
                );
                FeltStorage.setLockingToken(arguments[0], "stale-refresh-token")
                    .then(callback)
                    .catch(err => callback({_error: String(err)}));
                """,
                script_args=[WHOAMI_EMAIL],
            )
        finally:
            driver.set_context("content")

    def _crash_twice_to_abort(self):
        self.crash_parent()
        self.run_felt_proper_restart()
        self.run_felt_crash_parent_twice()
        self.run_felt_check_error_message()

    def test_browser_crash_abort_restart(self):
        self.policy_signout_crash_action.value = "signout"
        self._prepare_felt_keystore()
        self._seed_stale_locking_token()
        assert self.felt_has_locking_token(WHOAMI_EMAIL)

        self.run_felt_base()
        self._manually_closed_child = True
        self.connect_child_browser()
        self._crash_twice_to_abort()

        assert not self.felt_has_locking_token(WHOAMI_EMAIL)
        self.assert_user_signed_out(env=Environment.FELT)
        assert self.signout_count.value == 1

    def test_browser_crash_abort_restart_with_lock(self):
        self.policy_signout_crash_action.value = "lock"

        self._prepare_felt_keystore()
        self.run_felt_base()
        self._manually_closed_child = True
        self.connect_child_browser()
        self._crash_twice_to_abort()

        assert self.signout_count.value == 0
        assert self.felt_has_locking_token()

    def run_felt_check_error_message(self):
        self.await_felt_auth_window()
        self.force_window()

        self._driver.set_context("chrome")
        self._logger.info("Checking for error message")

        error_msg = self.get_elem(".felt-browser-error-multiple-crashes")
        assert "crashed multiple times" in error_msg.text, "Error message about crashes"
