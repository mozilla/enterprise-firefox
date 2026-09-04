#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_lock_tests import FeltLockTests

PREF_FORCE_PENDING_UPDATE = "enterprise.felt_tests.force_pending_update"
PREF_LOCK_ON_RESTART = "enterprise.locking.browser_restart"


class BrowserLockOnRestart(FeltLockTests):
    """Verify locking the FELT session on an update-driven restart.

    Applying an update relaunches the whole application, so FELT must persist
    the session behind OS auth (rather than sign out) to resume it afterwards.
    Only the update path locks; a plain restart keeps the session in memory and
    is not exercised here. Since a real update-driven restart (signed MAR +
    relaunch) is unreachable under Marionette, the update path is forced with a
    test pref, and FELT is held after the child exits (is_blocking_shutdown) so
    the persisted state can be inspected in place of the real relaunch.
    """

    def _hold_felt_after_child_exit(self):
        # Keep FELT alive after the child exits so we can inspect FELT-side state,
        # and force the update path since a real update-driven restart is not
        # reachable under Marionette.
        self.get_driver(Environment.FELT).set_prefs(
            {
                "enterprise.felt_tests.should_not_close_window": True,
                "enterprise.felt_tests.is_blocking_shutdown": True,
                PREF_FORCE_PENDING_UPDATE: True,
            },
            default_branch=True,
        )

    def _trigger_browser_restart(self):
        """Restart the browser the way an update would: a plain eRestart quit.
        The browser's Felt IPC client observes it and tags the restart with the
        cached lock intent; no BrowserGlue interception is involved."""
        self._child_driver.set_context("chrome")
        self._manually_closed_child = True
        self._child_driver.execute_script(
            """
            Services.startup.quit(
                Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart
            );
            """
        )

    def _begin_restart_test(self, *, locking_enabled):
        """Sign in, set the restart-locking pref, and assert no signout yet.

        Returns the child browser pid for _settle_after_child_exit."""
        browser_pid = self._start_signed_in()
        self._set_locking_pref(PREF_LOCK_ON_RESTART, locking_enabled)
        assert self.signout_count.value == 0, "No signout should have been posted yet"
        return browser_pid

    def test_lock_on_update_restart_persists_session_without_signout(self):
        """Locking enabled: an update-driven restart locks (no signout, token kept)."""
        browser_pid = self._begin_restart_test(locking_enabled=True)

        self._trigger_browser_restart()
        self._settle_after_child_exit(browser_pid)

        assert self.signout_count.value == 0, (
            f"Locking on restart must not post a signout, got {self.signout_count.value}"
        )
        assert self._felt_has_locking_token(), (
            "Locking on update-restart must persist an encrypted resume token"
        )

    def test_update_restart_without_locking_keeps_no_token(self):
        """Locking disabled: an update-driven restart neither locks nor signs out."""
        browser_pid = self._begin_restart_test(locking_enabled=False)

        self._trigger_browser_restart()
        self._settle_after_child_exit(browser_pid)

        assert not self._felt_has_locking_token(), (
            "Without locking, an update-restart must not persist a resume token"
        )
        assert self.signout_count.value == 0, (
            f"An update-restart must not post a signout, got {self.signout_count.value}"
        )
