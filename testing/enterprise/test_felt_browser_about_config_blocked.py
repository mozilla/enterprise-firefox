#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import sys
import time

import requests
from felt_tests import FeltTests
from selenium.common.exceptions import WebDriverException


class BrowserAboutConfigBlocked(FeltTests):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def test_felt_3_about_config_blocked_in_browser(self, exp):
        self.connect_child_browser()
        self._logger.info(
            f"Value of BlockAboutConfig policy: {self.policy_block_about_config.value}"
        )

        try:
            self.open_tab_child("about:config")
            assert False, "about:config should have been blocked in Firefox"
        except WebDriverException as ex:
            assert ex.msg.startswith(
                "Reached error page: about:neterror?e=blockedByPolicy&u=about%3Aconfig"
            ), "about:config is blocked in Firefox"

        return True

    def test_felt_4_change_about_config_policy(self, exp):
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
        return True

    def test_felt_5_about_config_allowed_in_browser(self, exp):
        self._logger.info(
            f"Value of BlockAboutConfig policy: {self.policy_block_about_config.value}"
        )

        self.open_tab_child("about:config")

        warning = self.get_elem_child("#warningTitle")
        assert warning is not None, "about:config is loadable in FELT"

        return True


if __name__ == "__main__":
    BrowserAboutConfigBlocked(
        "felt_browser_about_config_blocked.json",
        firefox=sys.argv[1],
        geckodriver=sys.argv[2],
        profile_root=sys.argv[3],
        env_vars={"MOZ_FELT_UI": "1"},
    )
