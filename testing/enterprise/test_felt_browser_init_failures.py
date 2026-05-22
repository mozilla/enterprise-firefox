#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

import requests

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests


class BrowserInitFailures(FeltTests):
    def setUp(self):
        super().setUp()
        self.config_polling_frequency.value = 600000

    def teardown(self):
        self.config_polling_frequency.value = 500
        super().teardown()

    def _assert_no_error_shown(self):
        with self._driver.using_context("chrome"):
            is_hidden = self._driver.execute_script(
                """
                const wrapper = document.querySelector(".felt-browser-error");
                return !wrapper || wrapper.classList.contains("is-hidden");
                """
            )
            assert is_hidden, "No error message should be visible before failure"

    def _assert_launch_failure_error_shown(self):
        with self._driver.using_context("chrome"):
            error_bar = self.get_elem(".felt-browser-error-launch-failure")
            heading = error_bar.get_attribute("heading").strip()
            assert "cannot start" in heading, f"Unexpected error bar heading: {heading}"

    def _get_active_policies_from_child(self):
        with self._child_driver.using_context("chrome"):
            return self._child_driver.execute_script(
                """
                return Services.policies.getActivePolicies();
                """
            )

    def _get_console_policies(self):
        return requests.get(
            f"http://localhost:{self.console_port}/api/browser/policies",
            headers={"Authorization": f"Bearer {self.policy_access_token.value}"},
        ).json()["policies"]

    def test_browser_init_policy_fetch_fail(self):
        self.force_window()
        self._assert_no_error_shown()

        # unsuccessful login
        self.policies_fail_request.value = 1
        super().run_felt_base()
        self.force_window()
        self._assert_launch_failure_error_shown()
        self.assert_user_signed_out(env=Environment.FELT)

        # successful login after failure
        self.policies_fail_request.value = 0
        super().run_felt_base()
        self._manually_closed_child = False
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)

        # Verify remote policies were applied to the child browser
        server_policies = self._get_console_policies()
        assert server_policies, "Server should return non-empty policies"

        active_policies = self._get_active_policies_from_child()
        self._logger.info(f"Server policies: {server_policies}")
        self._logger.info(f"Active policies: {active_policies}")
        assert active_policies == server_policies, (
            f"Active policies {active_policies} do not match "
            f"server policies {server_policies}"
        )
