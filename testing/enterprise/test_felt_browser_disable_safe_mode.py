#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_browser_safe_mode import BrowserSafeMode

# Browser counterpart to test_felt_startup_policies.py, with the checks of
# test_felt_browser_safe_mode.py expecting the browser not to be in safe mode.


class BrowserDisableSafeMode(BrowserSafeMode):
    def setUp(self):
        self._extra_cli_args = ["--safe-mode"]
        super().setUp()

    def test_browser_disable_safe_mode(self):
        self._logger.info("Serving DisableSafeMode before the browser spawns")
        self.policy_disable_safe_mode.value = 1

        self.run_felt_base()
        self.connect_child_browser()

        self._logger.info("Enable ExtensionSettings policy")
        self.policy_extensions.value = 1

        self.run_felt_assert_safe_mode(False)

        self._logger.info("Disable ExtensionSettings policy")
        self.policy_extensions.value = 0
