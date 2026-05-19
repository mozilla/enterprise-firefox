#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests

PREF_PROMPT_ON_SIGNOUT = "enterprise.prompt_on_signout"
PREF_WARN_ON_CLOSE = "browser.tabs.warnOnClose"


class BrowserCloseWarning(FeltTests):
    def _set_child_bool_pref(self, pref_name, value):
        """Set a boolean preference on the child browser via chrome context."""
        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            f"Services.prefs.setBoolPref('{pref_name}', {'true' if value else 'false'});"
        )
        self._child_driver.set_context("content")

    def _trigger_browser_closure(self, close_all_windows=False):
        """Simulate a natural browser close by firing quit-application-requested,
        which BrowserGlue intercepts to show the Enterprise signout dialog.

        If close_all_windows is True, all browser windows are closed first so
        that BrowserWindowTracker.getTopWindow() returns null, which causes
        BrowserGlue to open a standalone dialog (the macOS no-window path).
        """
        self._child_driver.set_context("chrome")
        self._manually_closed_child = True
        self._child_driver.execute_async_script(
            """
            const [closeWindows, resolve] = arguments;
            function triggerQuit(shouldResolve) {
                let cancelQuit = Cc["@mozilla.org/supports-PRBool;1"]
                    .createInstance(Ci.nsISupportsPRBool);
                Services.obs.notifyObservers(cancelQuit, "quit-application-requested", null);
                if (!cancelQuit.data) {
                    if (shouldResolve) resolve();
                    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
                } else if (shouldResolve) {
                    resolve();
                }
            }
            if (closeWindows) {
                const wins = [...Services.wm.getEnumerator('navigator:browser')];
                const closed = wins.map(win =>
                    new Promise(r => win.addEventListener('unload', r, { once: true }))
                );
                wins.forEach(win => win.close());
                // callback() must fire before the document unloads, so it is
                // called here rather than inside triggerQuit.
                Promise.all(closed).then(() => triggerQuit(false));
                resolve();
            } else {
                triggerQuit(true);
            }
            """,
            [close_all_windows],
        )

    def _wait_for_close_dialog(self):
        """Wait for the enterprise close dialog to be ready and store a
        reference to it on the chrome window for follow-up scripts.
        """
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

    def _get_close_dialog_content(self):
        """Return the title, message, and reauth text from the open close dialog."""
        return self._child_driver.execute_script(
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

    def _assert_close_dialog_content(
        self, expected_title, expected_message, expected_reauth=None
    ):
        """Wait for the close dialog and assert its title, message, and optional reauth text."""
        self._logger.info("Waiting for the custom signout dialog to assert its content")
        self._wait_for_close_dialog()
        content = self._get_close_dialog_content()
        assert content["title"] == expected_title, (
            f"Unexpected dialog title: {content['title']!r}"
        )
        assert content["message"] == expected_message, (
            f"Unexpected dialog message: {content['message']!r}"
        )
        assert content["reauth"] == (expected_reauth or ""), (
            f"Unexpected dialog reauth: {content['reauth']!r}"
        )

    def _accept_close_dialog(self):
        """Wait for the in-window close dialog and click its accept button."""
        self._logger.info("Waiting for the custom signout dialog to open")
        self._wait_for_close_dialog()

        self._logger.info(
            "Signing out the user by clicking the Signout button in the custom signout dialog"
        )
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

    def _accept_standalone_close_dialog(self, initial_handles):
        """Switch to and accept the standalone enterprise close dialog window,
        then switch back to the original window.

        Used for the macOS no-window case where the dialog opens outside any
        browser window.
        """
        self._logger.info("Waiting for standalone enterprise close dialog window")

        def get_new_handle(_):
            current = set(self._child_driver.chrome_window_handles)
            new = current - initial_handles
            return new.pop() if new else None

        dialog_handle = self._child_wait.until(get_new_handle)
        self._child_driver.switch_to_window(dialog_handle)

        self._child_wait.until(
            lambda _: self._child_driver.execute_script(
                "return !!document.getElementById('enterpriseCloseDialog')?.getButton('accept');"
            )
        )
        self._manually_closed_child = True
        self._logger.info("Clicking accept on standalone enterprise close dialog")
        self._child_driver.execute_script(
            "document.getElementById('enterpriseCloseDialog').getButton('accept').click();"
        )

    def _wait_for_child_browser_closed(self):
        """Poll until the child browser has fully closed."""
        self._logger.info("Waiting for child browser to close.")

        def is_closed(_):
            try:
                super(BrowserCloseWarning, self).assert_child_browser_closed()
                return True
            except AssertionError:
                return False

        self._child_wait.until(is_closed)

    def test_prompt_on_signout_default_is_true(self):
        """enterprise.prompt_on_signout must have a registered default of true."""
        self.run_felt_base()
        self.connect_child_browser()

        self._child_driver.set_context("chrome")
        is_registered = self._child_driver.execute_script(
            f"return Services.prefs.getDefaultBranch('').getPrefType('{PREF_PROMPT_ON_SIGNOUT}') === Services.prefs.PREF_BOOL;"
        )
        default_value = self._child_driver.execute_script(
            f"return Services.prefs.getDefaultBranch('').getBoolPref('{PREF_PROMPT_ON_SIGNOUT}', false);"
        )
        self._child_driver.set_context("content")

        assert is_registered, (
            f"{PREF_PROMPT_ON_SIGNOUT} has no registered default value"
        )
        assert default_value, (
            f"Expected {PREF_PROMPT_ON_SIGNOUT} default to be True, got {default_value!r}"
        )

    def test_browser_window_close_signout_warning_only(self):
        """Sign-out warn on, tabs warn off, single tab - enterprise signout dialog shows."""
        self.run_felt_base()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)

        self._set_child_bool_pref(PREF_PROMPT_ON_SIGNOUT, True)
        self._set_child_bool_pref(PREF_WARN_ON_CLOSE, False)

        self._trigger_browser_closure()
        self._assert_close_dialog_content(
            expected_title="Close Firefox Enterprise?",
            expected_message="You’re about to sign out of Firefox Enterprise and end your session.",
            expected_reauth="To use Firefox Enterprise again, you’ll need to reauthenticate through your organization’s SSO provider.",
        )
        self._accept_close_dialog()

        self._wait_for_child_browser_closed()
        self.assert_child_browser_closed()

    def test_browser_window_close_with_both_warnings(self):
        """Sign-out warn on, tabs warn on, multiple tabs open - enterprise dialog with tabs count shown."""
        self.run_felt_base()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)

        self._set_child_bool_pref(PREF_PROMPT_ON_SIGNOUT, True)
        self._set_child_bool_pref(PREF_WARN_ON_CLOSE, True)
        self.open_tab_child("about:blank")

        self._trigger_browser_closure()
        self._assert_close_dialog_content(
            expected_title="Close Firefox Enterprise and 2 tabs?",
            expected_message="You’re about to sign out of Firefox Enterprise and close 2 tabs.",
            expected_reauth="To use Firefox Enterprise again, you’ll need to reauthenticate through your organization’s SSO provider.",
        )
        self._accept_close_dialog()

        self._wait_for_child_browser_closed()
        self.assert_child_browser_closed()

    def test_browser_window_close_tabs_warning_only(self):
        """Sign-out warn off, tabs warn on, multiple tabs - dialog shows tabs-only variant."""
        self.run_felt_base()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)

        self._set_child_bool_pref(PREF_PROMPT_ON_SIGNOUT, False)
        self._set_child_bool_pref(PREF_WARN_ON_CLOSE, True)
        self.open_tab_child("about:blank")

        self._trigger_browser_closure()
        self._assert_close_dialog_content(
            expected_title="Close 2 tabs?",
            expected_message="Closing Firefox Enterprise will also sign you out.",
        )
        self._accept_close_dialog()

        self._wait_for_child_browser_closed()
        self.assert_child_browser_closed()

    def test_browser_window_close_no_warnings(self):
        """Sign-out warn off, tabs warn off - no dialog, quit proceeds directly."""
        self.run_felt_base()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)

        self._set_child_bool_pref(PREF_PROMPT_ON_SIGNOUT, False)
        self._set_child_bool_pref(PREF_WARN_ON_CLOSE, False)

        self._trigger_browser_closure()

        self._wait_for_child_browser_closed()
        self.assert_child_browser_closed()

    def test_browser_window_close_no_warnings_multiple_tabs(self):
        """Sign-out warn off, tabs warn off, multiple tabs - no dialog, quit proceeds."""
        self.run_felt_base()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)

        self._set_child_bool_pref(PREF_PROMPT_ON_SIGNOUT, False)
        self._set_child_bool_pref(PREF_WARN_ON_CLOSE, False)
        self.open_tab_child("about:blank")

        self._trigger_browser_closure()

        self._wait_for_child_browser_closed()
        self.assert_child_browser_closed()

    def test_browser_close_no_windows_shows_standalone_dialog(self):
        """macOS no-window: quitting with no browser windows shows a standalone
        enterprise dialog instead of crashing."""
        self.run_felt_base()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)

        self._set_child_bool_pref(PREF_PROMPT_ON_SIGNOUT, True)

        self._child_driver.set_context("chrome")
        initial_handles = set(self._child_driver.chrome_window_handles)
        self._trigger_browser_closure(close_all_windows=True)
        self._accept_standalone_close_dialog(initial_handles)
        self._wait_for_child_browser_closed()
        self.assert_child_browser_closed()
