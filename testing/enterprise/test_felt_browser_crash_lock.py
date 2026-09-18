#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_browser_crashes import BrowserCrashes

# The email the mock console's /api/browser/whoami returns; FELT records it as
# the last signed-in user, which keys the locking-token storage.
WHOAMI_EMAIL = "nobody@mozilla.org"


class BrowserCrashLock(BrowserCrashes):
    """Verify the lock-vs-signout decision when repeated crashes abort the
    automatic browser restart.

    The locking pref is locked by default, so it is driven through the real
    channel: the mock console serves the SignOut policy, the policy engine
    applies the pref, and the browser relays it to FELT. With locking enabled,
    the abort must persist an encrypted resume token without posting a server
    signout; with the default (signout) policy the abort must leave no resume
    token behind, even one stored earlier.
    """

    EXTRA_PREFS = {
        "enterprise.browser.abnormal_exit_limit": 2,
        "enterprise.browser.abnormal_exit_period": 120,
    }

    def _seed_stale_locking_token(self):
        """Simulate a session earlier resumed via unlock, whose stored token
        stays synced for the lifetime of the session.

        Runs before sign-in, while the FELT auth window still exists, and keys
        the token to the whoami email (not the typed sign-in email) so the
        sign-in flow does not divert into the OS-auth unlock path."""
        driver = self.get_driver(Environment.FELT)
        driver.set_context("chrome")
        try:
            driver.execute_script(
                f"""
                const {{ FeltStorage }} = ChromeUtils.importESModule(
                    "resource://gre/modules/enterprise/FeltStorage.sys.mjs"
                );
                return FeltStorage.setLockingToken(
                    "{WHOAMI_EMAIL}", "stale-refresh-token"
                );
                """
            )
        finally:
            driver.set_context("content")

    def _crash_twice_to_abort(self):
        self.crash_parent()
        self.run_felt_proper_restart()
        self.run_felt_crash_parent_twice()

    def _assert_crash_error_shown(self):
        self.await_felt_auth_window()
        self.force_window()
        self._driver.set_context("chrome")
        error_msg = self.get_elem(".felt-browser-error-multiple-crashes")
        assert "crashed multiple times" in error_msg.text, "Error message about crashes"

    def test_crash_lock_persists_session(self):
        self.policy_signout_crash_lock.value = 1

        self.run_felt_base()
        self._manually_closed_child = True
        self.connect_child_browser()
        self._crash_twice_to_abort()

        self._assert_crash_error_shown()
        assert self.signout_count.value == 0, (
            f"Locking on crash must not post a signout, got {self.signout_count.value}"
        )
        assert self.felt_has_locking_token(), (
            "Locking on crash must persist an encrypted resume token"
        )

    def test_crash_signout_clears_stale_token(self):
        self._seed_stale_locking_token()
        assert self.felt_has_locking_token(WHOAMI_EMAIL), "Seeded token must be stored"

        self.run_felt_base()
        self._manually_closed_child = True
        self.connect_child_browser()
        self._crash_twice_to_abort()

        self._assert_crash_error_shown()
        assert self.signout_count.value == 0, (
            f"The crash path posts no signout, got {self.signout_count.value}"
        )
        assert not self.felt_has_locking_token(), (
            "Aborting without the locking policy must not leave a resume token behind"
        )
