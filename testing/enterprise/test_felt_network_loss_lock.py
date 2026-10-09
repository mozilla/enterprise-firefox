#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests

PREF_LOCKING_NETWORK_LOSS = "enterprise.locking.network_loss"


class NetworkLossLock(FeltTests):
    """Verify the lock-vs-signout decision when the console stays unreachable.

    Losing the enterprise console means policy, posture and revocation can no
    longer be refreshed, so once the grace period elapses the session is ended
    either way; the SignOut NetworkLoss action decides whether it locks or
    signs out. Unlike a close, the user asked for none of this, so both paths
    must also leave FELT showing a notice saying what happened.

    The grace period is driven directly rather than waited out: its granularity
    is whole minutes, and the dispatch under test is what picks lock vs signout
    regardless of how long the wait was.
    """

    def _begin_network_loss_test(self, locking_enabled):
        """Sign in and set the network-loss locking pref, returning the child pid."""
        browser_pid = self._start_signed_in(keep_felt_window=False)
        self._set_locking_pref(PREF_LOCKING_NETWORK_LOSS, locking_enabled)
        assert self.signout_count.value == 0, "No signout should have been posted yet"
        return browser_pid

    def _end_session_for_network_loss(self):
        """Run the guard's enforcement off a dispatch so the script can return
        before the session tears down underneath the Marionette connection."""
        self._child_driver.set_context("chrome")
        self._manually_closed_child = True
        self._child_driver.execute_script(
            """
            const { EnterpriseHandler } = ChromeUtils.importESModule(
                "resource:///modules/enterprise/EnterpriseHandler.sys.mjs"
            );
            Services.tm.dispatchToMainThread(() => {
                EnterpriseHandler.endSessionForNetworkLoss();
            });
            """
        )

    def _assert_felt_notice(self, selector, expected_heading):
        """Assert FELT surfaced the notice explaining why the session ended."""
        self._driver.set_context("chrome")
        try:
            bar = self.get_elem(selector)
            heading = self._wait.until(
                lambda _: bar.get_attribute("heading"),
                message="Network-loss notice heading was not localized",
            ).strip()
            assert expected_heading in heading, f"Unexpected notice heading: {heading}"
        finally:
            self._driver.set_context("content")

    def test_network_loss_lock_explains_itself(self):
        """Locking enabled: on network loss the session locks and FELT says why.

        Without the notice the browser would just vanish on a user who never
        asked for anything, leaving them no idea the session is resumable.
        """
        browser_pid = self._begin_network_loss_test(locking_enabled=True)

        self._end_session_for_network_loss()
        self._settle_after_child_exit(browser_pid)

        self._assert_session_locked()
        self._assert_felt_notice(
            ".felt-browser-error-network-loss-locked", "Your session was locked"
        )

    def test_network_loss_signout_explains_itself(self):
        """Locking disabled: on network loss the session ends and FELT says why."""
        browser_pid = self._begin_network_loss_test(locking_enabled=False)

        self._end_session_for_network_loss()
        self._settle_after_child_exit(browser_pid)

        self._assert_session_signed_out()
        self._assert_felt_notice(
            ".felt-browser-error-network-loss", "You’ve been signed out"
        )
