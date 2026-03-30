#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys
import time
from urllib.parse import quote

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests, FeltLogoutChecker
from marionette_driver import errors
from marionette_driver.by import By


class BrowserTokenRefresh(FeltTests):
    def setup(self):
        super().setup()
        self.felt_logout_checker = FeltLogoutChecker(self)

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

    def _setup_child_browser_with_unload_tab(self, capabilities=None):
        super().run_felt_base()
        self.connect_child_browser(capabilities=capabilities)
        self.assert_user_signed_in(env=Environment.FIREFOX)

    def test_transparent_token_refresh(self):
        super().run_felt_base()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)

        old_access_token = self.policy_access_token.value
        self.policy_access_token.value = ""

        self.assert_user_signed_in(env=Environment.FIREFOX)

        self.policy_access_token.value = old_access_token

    def test_forced_signout_on_401(self):
        self._setup_child_browser_with_unload_tab()

        old_access_token = self.policy_access_token.value
        old_refresh_token = self.policy_refresh_token.value
        self.policy_access_token.value = ""
        self.policy_refresh_token.value = ""

        # Trigger an auth request with invalid tokens, expecting a forced logout.
        with self.felt_logout_checker.assert_browser_logouts_with(
            "console-forced-logout"
        ):
            self.get_logged_in_user_info(env=Environment.FIREFOX)
        self._manually_closed_child = True
        self.assert_child_browser_closed()

        self.await_felt_auth_window()
        self.force_window()
        self.assert_user_signed_out(env=Environment.FELT)

        self.policy_access_token.value = old_access_token
        self.policy_refresh_token.value = old_refresh_token

        self._driver.set_context("chrome")
        info_bar = self.get_elem(".felt-browser-info-console-forced-logout")
        heading = info_bar.get_attribute("heading").strip()
        assert "You've been signed out" in heading, (
            f"Unexpected info bar heading: {heading}"
        )
        self._driver.set_context("content")
