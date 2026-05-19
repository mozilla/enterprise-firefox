#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests
from marionette_driver.by import By


class BrowserTokenRefresh(FeltTests):
    def _setup_beforeunload_tab(self):
        # Creates a dirty tab with a beforeunload handler that will show a popup when closed.
        self._child_driver.navigate("about:blank")
        self._child_driver.execute_script(
            'document.body.innerHTML = \'<input placeholder="type something"><a href="about:blank#">leave</a>\';'
            "window.addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = ''; });"
        )
        input_el = self._child_driver.find_element(By.TAG_NAME, "input")
        input_el.click()
        input_el.send_keys("dirty")
        new_handle = self._child_driver.open(type="tab")
        self._child_driver.switch_to_window(new_handle["handle"])

    def trigger_token_refresh(self):
        driver = self.get_driver(Environment.FIREFOX)
        driver.set_context("chrome")
        try:
            driver.execute_script("Services.felt.refreshTokens();")
        except Exception:
            # refreshTokens() triggers an async IPC message to Felt and may throw
            # before the refresh completes. The exception is expected and harmless.
            pass
        driver.set_context("content")

    def assert_felt_tokens_cleared(self):
        driver = self.get_driver(Environment.FELT)
        driver.set_context("chrome")
        tokens = driver.execute_script(
            """
            return [
                Services.felt.getAccessTokenIfValid(),
                Services.felt.getRefreshToken(),
            ];
            """
        )
        driver.set_context("content")
        assert tokens[0] in ("", None), (
            f"FELT access token should be cleared after failed reauth, got: {tokens[0]}"
        )
        assert tokens[1] in ("", None), (
            f"FELT refresh token should be cleared after failed reauth, got: {tokens[1]}"
        )

    def assert_browser_closes_on_401(self):
        browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self.policy_access_token.value = ""
        self.policy_refresh_token.value = ""

        # We are waiting for the regularly scheduled policy fetch to fail with ReauthRequiredError:
        # Since Felt cannot get a new token without a refresh token, we expect the browser to close.
        # and Felt to display the auth dialog.
        self._manually_closed_child = True
        self.wait_process_exit(browser_pid)
        self.await_felt_auth_window()
        self.force_window()
        self.assert_user_signed_out(env=Environment.FELT)

    def test_transparent_token_refresh(self):
        super().run_felt_base()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)

        # Simulate token expiry by clearing the access token in Firefox.
        # Felt retains the refresh token and handles all token refreshes on Firefox's behalf.
        self._child_driver.set_context("chrome")
        self._child_driver.execute_script("Services.felt.clearTokens();")

        # Wait for the policy polling cycle to detect the missing token and trigger
        # a refresh via Felt. Resolves once Felt sends back a new access token.
        self._child_longwait.until(
            lambda d: d.execute_script(
                "return !!Services.felt.getAccessTokenIfValid();"
            )
        )
        self._child_driver.set_context("content")
        self.assert_user_signed_in(env=Environment.FIREFOX)

    def test_forced_signout_on_401(self):
        super().run_felt_base()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)
        self.assert_browser_closes_on_401()

    def test_beforeunload_is_closed_on_401(self):
        super().run_felt_base()
        self.connect_child_browser()
        self._setup_beforeunload_tab()
        self.assert_user_signed_in(env=Environment.FIREFOX)

        # Trigger the beforeunload dialog in a nonblocking way.
        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            "setTimeout(() => Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit), 0);"
        )
        self._child_driver.set_context("content")
        browser_pid = self._child_driver.session_capabilities["moz:processID"]

        # Wait for the dialog to confirm it is shown before Firefox is forced closed.
        self._child_wait.until(lambda d: d.switch_to_alert())

        # With the dialog active, invalidate both server tokens using only Python-level
        # shared memory — no Marionette interaction needed or safe here.
        # The policy poll will detect the 401, ask Felt to refresh (which fails with
        # ReauthRequired), and trigger quitIgnoringCanClose(), closing Firefox despite
        # the active beforeunload dialog.
        self.policy_access_token.value = ""
        self.policy_refresh_token.value = ""

        self._manually_closed_child = True
        self.wait_process_exit(browser_pid)
        self.await_felt_auth_window()
        self.force_window()

        self._driver.set_context("chrome")
        info_bar = self.get_elem(".felt-browser-error-token-refresh-failed")
        heading = info_bar.get_attribute("heading").strip()
        assert "You’ve been signed out" in heading, (
            f"Unexpected info bar heading: {heading}"
        )
        self._driver.set_context("content")

    def test_browser_reauth_required(self):
        self.get_driver(Environment.FELT).set_prefs(
            {"enterprise.felt_tests.is_blocking_shutdown": True},
            default_branch=True,
        )
        self.run_felt_base()
        self.connect_child_browser()
        browser_pid = self._child_driver.session_capabilities["moz:processID"]

        # Invalidate the server-side refresh token so the next refresh fails with 401
        self.policy_refresh_token.value = "invalid-token"

        # Trigger a token refresh from Firefox via XPCOM IPC to FELT
        self.trigger_token_refresh()
        self._manually_closed_child = True
        self.wait_process_exit(browser_pid)

        # FELT should display the authentication window again
        self.await_felt_auth_window()
        self.force_window()

        # FELT tokens should have been cleared
        self.assert_felt_tokens_cleared()
