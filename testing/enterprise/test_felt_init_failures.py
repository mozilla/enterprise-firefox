#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests


class AppInitFailures(FeltTests):
    def test_browser_init_policy_fetch_fail(self):
        self.policies_fail_request.value = 1
        # After SSO completion, FELT closes its auth window and spawns the
        # child Firefox. The child fails its policy fetch and exits, which
        # causes FELT to re-open a new auth window.
        with self.expect_new_felt_auth_window():
            self.run_felt_base()
            self._manually_closed_child = True
        self.policies_fail_request.value = 0
        self.assert_user_signed_out(env=Environment.FELT)

    def test_browser_init_primary_secret_fetch_fail(self):
        # The Felt UI fetches the SQLite at-rest-encryption primarySecret
        # (/api/browser/key) before spawning Firefox; without it the spawned
        # browser cannot unlock its encrypted profile databases. When that fetch
        # fails the launch is aborted and the launch-failure error is shown to
        # the user, rather than leaving Felt backgrounded with no browser.
        self.key_fail_request.value = 1
        self.run_felt_base()
        # The child Firefox is never spawned, so there is nothing to close.
        self._manually_closed_child = True

        # On SSO completion Felt asynchronously backgrounds its window, fetches
        # the primarySecret (which fails here), and only then surfaces the
        # launch-failure window -- a chain that does network I/O and briefly
        # leaves no Felt window open. Poll for that window to actually appear
        # and show the error, rather than racing a transient window count on
        # the short waiter; this returns as soon as the error is shown. Keep
        # key_fail_request set until the failure is observed: the getPrimarySecret
        # fetch happens after run_felt_base() returns, so resetting it earlier
        # races the fetch and lets the launch succeed.
        self._driver.set_context("chrome")

        def launch_failure_shown(_):
            try:
                handles = self._driver.chrome_window_handles
                if len(handles) != 1:
                    return False
                self._driver.switch_to_window(handles[0])
                self._driver.set_context("chrome")
                error = self.get_elem(".felt-error-primary-secret")
                return error if error.is_displayed() else False
            except Exception:
                return False

        error_msg = self._longwait.until(launch_failure_shown)
        self.key_fail_request.value = 0
        self.maybe_save_screenshot(Environment.FELT, self._testMethodName)
        assert error_msg.is_displayed(), (
            "primary-secret error shown when primarySecret is unavailable"
        )
