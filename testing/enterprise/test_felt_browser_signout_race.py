#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests
from marionette_driver.errors import UnexpectedAlertOpen
from marionette_driver.wait import Wait


class BrowserSignoutRace(FeltTests):
    """Regression test for the race between proc.exitPromise and logoutReported.

    When Firefox calls performNormalLogout() followed immediately by quit(), the
    felt-firefox-logout notification is dispatched from the Rust ipc_loop thread
    to the JS main thread. proc.exitPromise also resolves via the subprocess
    worker on the main thread. Without the fix, if proc.exitPromise.then() checks
    logoutReported before logoutFirefox() runs, it sends FirefoxNormalExit.
    logoutFirefox() then also sends FirefoxLogoutExit. Both call showWindow(),
    producing 2 windows.

    The fix chains proc.exitPromise through _ipcDrainedPromise, which resolves
    only when the Rust ipc_loop emits felt-firefox-ipc-disconnected. IPC ordering
    guarantees FeltMessage::Logout is fully processed before Disconnected fires,
    so logoutReported is always true by the time the exit chain runs.

    FELT_TEST_LOGOUT_DELAY_MS simulates a slow Rust thread by sleeping in the
    Logout arm before dispatching felt-firefox-logout, exposing the race without
    the fix. With the fix, only 1 window (the logout screen) should appear.
    """

    # Must exceed FELT_TEST_LOGOUT_DELAY_MS to catch any delayed second window.
    _RACE_WINDOW_TIMEOUT_S = 2.0

    def test_browser_signout_race(self):
        self.get_driver(Environment.FELT).set_prefs(
            {
                "enterprise.felt_tests.is_blocking_shutdown": True,
            },
            default_branch=True,
        )

        # Set the Rust ipc_loop delay before run_felt_base() while the FELT
        # window is still open. After run_felt_base() FELT transitions to
        # background and closes its window, making execute_script fail.
        with self._driver.using_context("chrome"):
            self._driver.execute_script(
                """
                const env = Cc["@mozilla.org/process/environment;1"]
                  .getService(Ci.nsIEnvironment);
                env.set("FELT_TEST_LOGOUT_DELAY_MS", "500");
                """
            )

        self.run_felt_base()
        self._trigger_signout()

        # Give time for any race-induced second window to appear. The fix
        # guarantees only 1 window (the logout screen from FirefoxLogoutExit).
        try:
            Wait(self._driver, timeout=self._RACE_WINDOW_TIMEOUT_S).until(
                lambda mn: len(self._driver.chrome_window_handles) >= 2
            )
        except Exception:
            pass

        assert len(self._driver.chrome_window_handles) == 1, (
            f"Expected 1 window after signout, got "
            f"{len(self._driver.chrome_window_handles)}. "
            "Race condition: proc.exitPromise resolved before logoutReported was "
            "set, causing both FirefoxNormalExit and FirefoxLogoutExit to call "
            "showWindow()."
        )

    def _trigger_signout(self):
        self.connect_child_browser(capabilities={"unhandledPromptBehavior": "ignore"})

        self._child_driver.set_context("chrome")
        self.get_elem_child("#enterprise-badge-toolbar-button").click()

        try:
            self.get_elem_child(".panelUI-enterprise__sign-out-btn").click()
        except UnexpectedAlertOpen:
            pass

        self._child_driver.switch_to_alert().accept()
        self._manually_closed_child = True
