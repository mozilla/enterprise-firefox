#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests

PREF_LOCKING_RESTART = "enterprise.locking.restart"


class AppRestartLock(FeltTests):
    """Verify locking the FELT session on an update-driven restart.

    Applying an update relaunches the whole application, so FELT must persist
    the session behind OS auth (rather than sign out) to resume it afterwards.
    Only the update path locks; a plain restart keeps the session in memory,
    and both sides of that gate are covered here. Since a real update-driven
    restart (signed MAR + relaunch) is unreachable under Marionette, FELT's
    ready-update lookup is stubbed, and FELT is held after the child exits
    (is_blocking_shutdown) so the persisted state can be inspected in place of
    the real relaunch.

    Unlike the close flow, a restart is a plain eRestart quit that the browser's
    Felt IPC client tags with the cached lock intent, so nothing here goes
    through BrowserGlue.
    """

    def _stub_pending_update(self):
        """Make FELT see a ready update, so the restart takes the update path.

        FELT only reads the update's state, and there is no way to build an
        nsIUpdate from a test, so stub the getter rather than stage a real
        update: downloading and applying a signed MAR is not reachable here."""
        driver = self.get_driver(Environment.FELT)
        driver.set_context("chrome")
        try:
            driver.execute_script(
                """
                const { UpdateManager } = ChromeUtils.importESModule(
                    "resource://gre/modules/UpdateService.sys.mjs"
                );
                UpdateManager.prototype.getReadyUpdate = async () => ({
                    state: "pending",
                });
                """
            )
        finally:
            driver.set_context("content")

    def _begin_restart_test(self, *, locking_enabled):
        """Sign in, set the restart-locking pref, and assert no signout yet.

        Returns the child browser pid for _settle_after_child_exit."""
        browser_pid = self._start_signed_in()
        self._stub_pending_update()
        self._set_locking_pref(PREF_LOCKING_RESTART, locking_enabled)
        assert self.signout_count.value == 0, "No signout should have been posted yet"
        return browser_pid

    def _seed_locking_token(self):
        driver = self.get_driver(Environment.FELT)
        driver.set_context("chrome")
        try:
            driver.execute_async_script(
                """
                const callback = arguments[arguments.length - 1];
                const { FeltStorage } = ChromeUtils.importESModule(
                    "resource://gre/modules/enterprise/FeltStorage.sys.mjs"
                );
                const email = FeltStorage.getLastSignedInUser();
                FeltStorage.setLockingToken(email, "stale-token", "stale-user")
                    .then(callback)
                    .catch(err => callback({_error: String(err)}));
                """
            )
        finally:
            driver.set_context("content")

    def test_lock_on_update_restart_persists_session_without_signout(self):
        """Locking enabled: an update-driven restart locks (no signout, token kept)."""
        browser_pid = self._begin_restart_test(locking_enabled=True)

        self.quit_child_browser_for_restart()
        self._settle_after_child_exit(browser_pid)

        self._await_felt_locking_token(
            True, "Locking on update-restart must persist an encrypted resume token"
        )
        assert self.signout_count.value == 0, (
            f"Locking on restart must not post a signout, got {self.signout_count.value}"
        )

    def test_update_restart_without_locking_clears_preexisting_token(self):
        """Locking disabled: an update-driven restart clears stale credentials."""
        browser_pid = self._begin_restart_test(locking_enabled=False)
        self._seed_locking_token()
        assert self._felt_has_locking_token(), "The test must begin with a stored token"

        self.quit_child_browser_for_restart()
        self._settle_after_child_exit(browser_pid)

        self._await_felt_locking_token(
            False,
            "Without locking, an update-restart must clear the stored resume token",
        )
        assert self.signout_count.value == 1, (
            "An update-restart without locking must post exactly one signout, "
            f"got {self.signout_count.value}"
        )

    def test_plain_restart_with_locking_keeps_session_in_memory(self):
        """Locking enabled, no pending update: the restart must not lock.

        Guards the pendingUpdate gate: FELT relaunches the browser in place and
        keeps the session in memory, so there is nothing to persist and nothing
        to sign out."""
        browser_pid = self._start_signed_in()
        self._set_locking_pref(PREF_LOCKING_RESTART, True)
        assert not self._felt_has_locking_token(), (
            "The test must begin with no stored token"
        )

        self.quit_child_browser_for_restart()
        self.wait_process_exit(browser_pid)

        self.connect_child_browser()
        # FELT relaunched the browser, so teardown owns closing it after all.
        self._manually_closed_child = False
        new_browser_pid = self._child_driver.session_capabilities["moz:processID"]
        assert new_browser_pid != browser_pid, (
            f"Expected a relaunched process, still {new_browser_pid}"
        )
        self.assert_user_signed_in(env=Environment.FIREFOX)

        assert not self._felt_has_locking_token(), (
            "A restart without a pending update must not persist a resume token"
        )
        assert self.signout_count.value == 0, (
            f"A restart without a pending update must not sign out, got {self.signout_count.value}"
        )
