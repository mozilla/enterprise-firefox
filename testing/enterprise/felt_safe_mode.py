#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

from felt_tests import FeltTests


class SafeModeBase(FeltTests):
    """
    Checks of whether Felt and its child run in safe mode, working for both
    Firefox and Thunderbird. felt_browser_safe_mode.py has Firefox-only checks.
    """

    def assert_felt_safe_mode(self, expected):
        self._driver.set_context("chrome")
        safe_mode_felt = self._driver.execute_script(
            "return Services.appinfo.inSafeMode;"
        )
        self._driver.set_context("content")
        assert safe_mode_felt is expected, (
            f"FELT should report inSafeMode {expected}, was {safe_mode_felt}"
        )

    def assert_child_safe_mode(self, expected):
        self._child_driver.set_context("chrome")
        safe_mode_child = self._child_driver.execute_script(
            "return Services.appinfo.inSafeMode;"
        )
        self._child_driver.set_context("content")
        assert safe_mode_child is expected, (
            f"Child should report inSafeMode {expected}, was {safe_mode_child}"
        )
