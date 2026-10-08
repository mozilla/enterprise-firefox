#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys
import uuid

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests


class FeltDevicePostureRefreshRejected(FeltTests):
    """A console that refuses the refresh token on a posture submission ends the
    session, as it does on the refresh the browser drives. The posture monitor is
    the only initiator here: the browser holds a valid access token throughout, so
    it never asks FELT to refresh."""

    def teardown(self):
        # The browser is expected to be gone by the end of the test; if it is,
        # skip the child-close path in FeltTestsBase.teardown().
        if hasattr(self, "_child_driver"):
            try:
                self._child_driver.set_context("chrome")
                self._child_driver.execute_script("return true;")
            except Exception:
                self._manually_closed_child = True
        return super().teardown()

    def test_rejected_posture_refresh_ends_the_session(self):
        super().run_felt_base()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)

        browser_pid = self._child_driver.session_capabilities["moz:processID"]

        # Rotate the console's refresh token so the one FELT holds is stale: its
        # next refresh gets a 401. The access token stays valid, so the browser's
        # policy polls keep succeeding and drive no refresh of their own.
        self.policy_refresh_token.value = str(uuid.uuid4())

        # Change the posture the monitor reads, which is what makes it submit.
        self.policy_extensions.value = 1

        self.wait_process_exit(browser_pid)

        # FELT comes back with the expired-session notice, the one a refused
        # refresh token maps to, and holds no credentials for the session the
        # console rejected.
        self.await_felt_auth_window()
        self.force_window()
        self._driver.set_context("chrome")
        self.get_elem(".felt-browser-error-session-expired")
        tokens = self._driver.execute_script(
            """
            return {
                access: Services.felt.getAccessTokenIfValid(),
                refresh: Services.felt.getRefreshToken(),
            };
            """
        )
        self._driver.set_context("content")
        assert not tokens["access"], f"Access token was not cleared: {tokens['access']}"
        assert not tokens["refresh"], (
            f"Refresh token was not cleared: {tokens['refresh']}"
        )
