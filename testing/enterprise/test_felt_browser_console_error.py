#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTestsBase


class FeltConsoleError(FeltTestsBase):
    def teardown(self):
        if not hasattr(self, "_child_driver"):
            self._manually_closed_child = True
        return super().teardown()

    def connection_error_test(self, console_addr, error_msg):
        self.set_string_pref("enterprise.console.address", console_addr)

        self.submit_email()

        self._driver.set_context("chrome")
        error = self.get_elem(".felt-browser-error-connection")
        message = error.get_property("textContent").strip()
        assert "Unable to connect" in message, f"Unexpected error message: {message}"

        details = self.get_elem(".felt-browser-error-details")
        details_text = details.get_property("textContent").strip()
        assert details_text == error_msg, f"Correct error message: '{details_text}'"

        self._driver.set_context("content")

    def test_felt_00_connection_error_fluent(self):
        return self.connection_error_test("http://127.0.0.1:1", "Unknown network error")

    def test_felt_01_connection_error_bundle(self):
        return self.connection_error_test(
            "http://nonexistent.localdomain:80",
            "We can’t connect to the server at nonexistent.localdomain.",
        )
