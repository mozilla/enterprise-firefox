#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_browser_safe_mode import BrowserSafeMode


class FeltStartsBrowserSafeMode(BrowserSafeMode):
    def setUp(self):
        self._extra_cli_args = ["--safe-mode"]
        super().setUp()

    def test_felt_starts_browser_safe_mode(self):
        self._driver.set_context("chrome")
        safe_mode_felt = self._driver.execute_script(
            "return Services.appinfo.inSafeMode;"
        )
        self._driver.set_context("content")

        assert safe_mode_felt is False, "FELT should report not in safe mode"

        super().run_felt_base()
        self.run_felt_browser_started()
        self.run_felt_assert_safe_mode(True)

        self._logger.info("Disable ExtensionSettings policy")
        self.policy_extensions.value = 0

    def run_felt_browser_started(self):
        self.connect_child_browser()
        self.assert_child_safe_mode(True)

        self._logger.info("Enable ExtensionSettings policy")
        self.policy_extensions.value = 1
