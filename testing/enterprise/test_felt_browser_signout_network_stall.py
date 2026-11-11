#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys
import time

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from test_felt_browser_signout import BaseBrowserSignout

# Well under the 60s console request timeout, so a browser that waits on the
# console fails.
BROWSER_EXIT_BUDGET_S = 8


class BrowserSignoutNetworkStall(BaseBrowserSignout):
    """Signing out from the enterprise panel closes the browser right away even
    when the console does not answer, and only offers sign-in again once the
    previous session has been torn down."""

    def tearDown(self):
        # Release a stalled request so the console can serve teardown.
        self.signout_stall.value = 0
        super().tearDown()

    def _is_running(self, pid):
        import psutil

        try:
            return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            return False

    def test_browser_signout_network_stall(self):
        self.run_felt_base()
        self.connect_child_browser(capabilities={"unhandledPromptBehavior": "ignore"})
        self.assert_user_signed_in(env=Environment.FIREFOX)
        browser_pid = self._child_driver.session_capabilities["moz:processID"]

        self.signout_stall.value = 1
        self._accept_signout_dialog()
        self._manually_closed_child = True
        signout_started = time.monotonic()

        while (
            self._is_running(browser_pid)
            and time.monotonic() - signout_started < BROWSER_EXIT_BUDGET_S
        ):
            time.sleep(0.2)
        assert not self._is_running(browser_pid), (
            f"Browser still running {BROWSER_EXIT_BUDGET_S}s after signout; "
            "it must not wait on the console"
        )

        assert len(self._driver.chrome_window_handles) == 0, (
            "Sign-in window shown before the previous session was torn down"
        )
        assert self.signout_count.value == 0, (
            "Stalled signout should not have completed yet"
        )

        self.signout_stall.value = 0
        self.await_felt_auth_window()
        self.force_window()
        assert self.signout_count.value == 1, (
            f"Expected exactly 1 signout request, got {self.signout_count.value}"
        )
        self.assert_user_signed_out(env=Environment.FELT)
