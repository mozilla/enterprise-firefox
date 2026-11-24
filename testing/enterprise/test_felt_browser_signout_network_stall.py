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

# Under the console signout timeout, so a browser that waits on the console
# fails.
BROWSER_EXIT_BUDGET_S = 8


class BrowserSignoutNetworkStall(BaseBrowserSignout):
    """Signing out from the enterprise panel closes the browser right away even
    when the console does not answer. The sign-in window then shows a signing
    out pane in place of the sign-in form until the previous session has been
    torn down."""

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

        self.await_felt_auth_window()
        self.force_window()
        # FELT's own DOM is only reachable from chrome; content is the SSO browser.
        self._driver.set_context("chrome")
        signing_out = self.get_elem(".felt-signing-out-pane")
        self.maybe_save_screenshot(Environment.FELT, "signing_out_pane")
        assert not self.find_elem("#felt-form__email").is_displayed(), (
            "Sign-in must stay hidden until the previous session is torn down"
        )
        self._driver.set_context("content")
        assert self.signout_count.value == 0, (
            "Stalled signout should not have completed yet"
        )

        self.await_signout_settled()
        self._driver.set_context("chrome")
        assert not signing_out.is_displayed(), "Signing out pane should be removed"
        self.get_elem("#felt-form__email")
        self._driver.set_context("content")
        assert self.signout_count.value == 0, (
            "The timed out signout should never have reached the console"
        )
        self.assert_user_signed_out(env=Environment.FELT)
