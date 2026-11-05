#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_browser_safe_mode import BrowserSafeModeBase

# Firefox-specific assertions for safe mode beyond generic assertions in
# test_felt_safe_mode.py.


class FeltStartsBrowserSafeMode(BrowserSafeModeBase):
    def setUp(self):
        self._extra_cli_args = ["--safe-mode"]
        super().setUp()

    def test_felt_starts_browser_safe_mode(self):
        self.run_felt_base()
        self.connect_child_browser()

        self.assert_browser_safe_mode(True)
