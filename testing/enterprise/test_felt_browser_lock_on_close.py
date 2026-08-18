#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests

PREF_LOCK_ON_CLOSE = "enterprise.locking.browser_close"
PREF_PROMPT_ON_SIGNOUT = "enterprise.prompt_on_signout"


class BrowserLockOnClose(FeltTests):
    """Verify the lock-vs-signout decision when closing a FELT browser.

    The distinguishing signal is whether a server signout is posted (a lock
    must not sign out) and whether an encrypted resume token is persisted by
    FELT. Both are asserted here, with and without the confirmation prompt.
    """

    def _hold_felt_after_child_exit(self):
        # Keep FELT alive after the child exits so we can inspect FELT-side state.
        self.get_driver(Environment.FELT).set_prefs(
            {
                "enterprise.felt_tests.should_not_close_window": True,
                "enterprise.felt_tests.is_blocking_shutdown": True,
            },
            default_branch=True,
        )

    def _trigger_browser_closure(self):
        """Fire quit-application-requested, which BrowserGlue routes to the
        enterprise lock/signout flow for a FELT browser."""
        self._child_driver.set_context("chrome")
        self._manually_closed_child = True
        self._child_driver.execute_script(
            """
            let cancelQuit = Cc["@mozilla.org/supports-PRBool;1"]
                .createInstance(Ci.nsISupportsPRBool);
            Services.obs.notifyObservers(cancelQuit, "quit-application-requested", null);
            // The enterprise flow cancels this quit and drives shutdown itself;
            // only quit here if nothing claimed it.
            if (!cancelQuit.data) {
                Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
            }
            """
        )

    def _wait_for_close_dialog(self):
        self._child_wait.until(
            lambda _: self._child_driver.execute_script(
                """
                try {
                    const dialog = document.getElementById('window-modal-dialog');
                    return !!(dialog?.open && dialog.querySelector(".dialogFrame")
                        ?.contentDocument
                        ?.getElementById("enterpriseCloseDialog")
                        ?.getButton('accept'));
                } catch (e) {
                    return false;
                }
                """
            )
        )

    def _assert_close_dialog_content(self, expected_message, expected_reauth):
        self._wait_for_close_dialog()
        content = self._child_driver.execute_script(
            """
            const doc = document.getElementById('window-modal-dialog')
                .querySelector('.dialogFrame').contentDocument;
            return {
                title: doc.getElementById('infoTitle').textContent,
                message: doc.getElementById('infoBody').textContent,
                reauth: doc.getElementById('infoReauth').textContent,
            };
            """
        )
        assert content["title"] == "Close Firefox Enterprise?", (
            f"Unexpected dialog title: {content['title']!r}"
        )
        assert content["message"] == expected_message, (
            f"Unexpected dialog message: {content['message']!r}"
        )
        assert content["reauth"] == expected_reauth, (
            f"Unexpected dialog reauth: {content['reauth']!r}"
        )

    def _accept_close_dialog(self):
        self._wait_for_close_dialog()
        self._child_driver.execute_script(
            """
            document.getElementById("window-modal-dialog")
                .querySelector(".dialogFrame")
                .contentDocument
                .getElementById("enterpriseCloseDialog")
                .getButton("accept")
                .click();
            """
        )

    def _felt_has_locking_token(self):
        """Whether FELT persisted an encrypted resume token for the signed-in user."""
        driver = self.get_driver(Environment.FELT)
        driver.set_context("chrome")
        try:
            return driver.execute_script(
                """
                const { FeltStorage } = ChromeUtils.importESModule(
                    "resource://gre/modules/enterprise/FeltStorage.sys.mjs"
                );
                const email = FeltStorage.getLastSignedInUser();
                return !!(email && FeltStorage.hasLockingToken(email));
                """
            )
        finally:
            driver.set_context("content")

    def _settle_after_close(self, browser_pid):
        self.wait_process_exit(browser_pid)
        self.await_felt_auth_window()
        self.force_window()

    def _start_signed_in(self):
        self._hold_felt_after_child_exit()
        self.run_felt_base()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)
        return self._child_driver.session_capabilities["moz:processID"]

    def test_lock_on_close_persists_session_without_signout(self):
        """Locking enabled, prompt disabled: closing locks (no signout, token kept)."""
        browser_pid = self._start_signed_in()
        # enterprise.locking.browser_close ships locked, and set_prefs can't
        # modify a locked pref; unlock it so the set_prefs below takes effect.
        with self._child_driver.using_context("chrome"):
            self._child_driver.execute_script(
                "Services.prefs.unlockPref(arguments[0]);",
                script_args=[PREF_LOCK_ON_CLOSE],
            )
        self._child_driver.set_prefs({
            PREF_LOCK_ON_CLOSE: True,
            PREF_PROMPT_ON_SIGNOUT: False,
        })

        assert self.signout_count.value == 0, "No signout should have been posted yet"

        self._trigger_browser_closure()
        self._settle_after_close(browser_pid)

        assert self.signout_count.value == 0, (
            f"Locking must not post a signout, got {self.signout_count.value}"
        )
        assert self._felt_has_locking_token(), (
            "Locking must persist an encrypted resume token"
        )

    def test_signout_on_close_when_locking_disabled(self):
        """Locking disabled, prompt disabled: closing signs out (no token kept)."""
        browser_pid = self._start_signed_in()
        self._child_driver.set_prefs({
            PREF_LOCK_ON_CLOSE: False,
            PREF_PROMPT_ON_SIGNOUT: False,
        })

        assert self.signout_count.value == 0, "No signout should have been posted yet"

        self._trigger_browser_closure()
        self._settle_after_close(browser_pid)

        assert self.signout_count.value == 1, (
            f"Expected exactly 1 signout request, got {self.signout_count.value}"
        )
        assert not self._felt_has_locking_token(), (
            "Signing out must not leave a resume token behind"
        )
        self.assert_user_signed_out(env=Environment.FELT)

    def test_prompt_lock_dialog_accept_locks(self):
        """Locking enabled, prompt enabled: dialog shows lock wording; accept locks."""
        browser_pid = self._start_signed_in()
        self._child_driver.set_prefs({
            PREF_LOCK_ON_CLOSE: True,
            PREF_PROMPT_ON_SIGNOUT: True,
        })

        self._trigger_browser_closure()
        self._assert_close_dialog_content(
            expected_message="Your session will be locked.",
            expected_reauth="You can resume your session after authenticating on this device.",
        )
        self._accept_close_dialog()
        self._settle_after_close(browser_pid)

        assert self.signout_count.value == 0, (
            f"Locking must not post a signout, got {self.signout_count.value}"
        )
        assert self._felt_has_locking_token(), (
            "Locking must persist an encrypted resume token"
        )

    def test_prompt_signout_dialog_accept_signs_out(self):
        """Locking disabled, prompt enabled: dialog shows signout wording; accept signs out."""
        browser_pid = self._start_signed_in()
        self._child_driver.set_prefs({
            PREF_LOCK_ON_CLOSE: False,
            PREF_PROMPT_ON_SIGNOUT: True,
        })

        self._trigger_browser_closure()
        self._assert_close_dialog_content(
            expected_message="You’re about to sign out of Firefox Enterprise and end your session.",
            expected_reauth="To use Firefox Enterprise again, you’ll need to reauthenticate through your organization’s SSO provider.",
        )
        self._accept_close_dialog()
        self._settle_after_close(browser_pid)

        assert self.signout_count.value == 1, (
            f"Expected exactly 1 signout request, got {self.signout_count.value}"
        )
        assert not self._felt_has_locking_token(), (
            "Signing out must not leave a resume token behind"
        )
