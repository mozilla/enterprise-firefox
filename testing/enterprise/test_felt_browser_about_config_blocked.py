#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys
import time

sys.path.append(os.path.dirname(__file__))

import requests
from felt_tests import FeltTests
from marionette_driver.errors import UnknownException


class BrowserAboutConfigBlocked(FeltTests):
    def test_browser_about_config_blocked(self):
        super().run_felt_base()
        self.run_about_config_blocked_in_browser()
        self.run_change_about_config_policy()
        self.run_about_config_allowed_in_browser()

    def run_about_config_blocked_in_browser(self):
        self.connect_child_browser()
        self._logger.info(
            f"Value of BlockAboutConfig policy: {self.policy_block_about_config.value}"
        )

        try:
            self.open_tab_child("about:config")
            assert False, "about:config should have been blocked in Firefox"
        except UnknownException as ex:
            assert ex.message.startswith(
                "Reached error page: about:neterror?e=blockedByPolicy&u=about%3Aconfig"
            ), "about:config is blocked in Firefox"

    def run_change_about_config_policy(self):
        self._logger.info("Changing BlockAboutConfig policy")
        self.policy_block_about_config.value = 0
        self._logger.info("Changed BlockAboutConfig policy")

        url = f"http://localhost:{self.console_port}/api/browser/policies"
        max_try = 0
        while max_try < 20:
            max_try += 1
            try:
                r = requests.get(
                    f"{url}",
                    headers={
                        "Authorization": f"Bearer {self.policy_access_token.value}"
                    },
                )
                j = r.json()
                if not ("BlockAboutConfig" in j["policies"]):
                    self._logger.info(f"Policy update propagated at {url}!")
                    break
                self._logger.info(f"Policy update not yet propagated at {url}")
                time.sleep(0.5)
            except Exception as ex:
                self._logger.info(f"Policy update issue {url}: {ex}")
                time.sleep(2)

        # Give time to make sure Policy got applied
        time.sleep(2)

        self._logger.info("Policy update propagated, continue tests")

    def run_about_config_allowed_in_browser(self):
        self._logger.info(
            f"Value of BlockAboutConfig policy: {self.policy_block_about_config.value}"
        )

        self.open_tab_child("about:config")

        warning = self.get_elem_child("#warningTitle")
        assert warning is not None, "about:config is loadable in FELT"
