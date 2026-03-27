#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTestsBase


class FeltEmailInputFocus(FeltTestsBase):
    """
    Test that the email input in the FELT login form is focused on launch.
    """

    def teardown(self):
        self._manually_closed_child = True
        super().teardown()

    # Bug 2006564
    def test_felt_email_input_is_focused(self):
        self._driver.set_context("chrome")

        self._wait.until(
            lambda _: self._driver.execute_script(
                """
                const host = document.getElementById("felt-form__email");
                const focused = document.commandDispatcher.focusedElement;
                return focused === host || host?.shadowRoot?.contains(focused);
                """
            )
        )

        self._driver.set_context("content")
