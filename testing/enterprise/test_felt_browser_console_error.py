#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import sys

from felt_tests import FeltTestsBase


class FeltConsoleError(FeltTestsBase):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def teardown(self):
        if not hasattr(self, "_child_driver"):
            self._manually_closed_child = True
        return super().teardown()

    def test_felt_00_connection_error_display(self, exp):
        console_addr = "http://127.0.0.1:1"
        self.set_string_pref("enterprise.console.address", console_addr)

        self.submit_email()

        self._driver.set_context("chrome")
        error = self.get_elem(".felt-browser-error-connection")
        message = error.get_property("textContent").strip()
        assert "Unable to connect" in message, f"Unexpected error message: {message}"

        details = self.get_elem(".felt-browser-error-details")
        details_text = details.get_property("textContent").strip()
        assert details_text, "No error details shown"

        self._driver.set_context("content")
        return True


if __name__ == "__main__":
    FeltConsoleError(
        "felt_browser_console_error.json",
        firefox=sys.argv[1],
        geckodriver=sys.argv[2],
        profile_root=sys.argv[3],
        cli_args=["-feltUI"],
    )
