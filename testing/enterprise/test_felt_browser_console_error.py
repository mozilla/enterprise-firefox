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

    def check_error_bar_message(
        self,
        console_addr,
        selector,
        expected_heading,
        error_msg=None,
        error_msg_contains=None,
    ):
        self.set_string_pref("enterprise.console.address", console_addr)

        self.submit_email()

        self._driver.set_context("chrome")
        error = self.get_elem(selector)
        message = error.get_attribute("heading").strip()
        assert expected_heading in message, f"Unexpected error message: {message}"

        if error_msg is not None:
            details = self.get_elem(f"{selector} .felt-browser-error-details")
            details_text = details.get_property("textContent").strip()
            assert details_text == error_msg, f"Correct error message: '{details_text}'"

        if error_msg_contains is not None:
            details = self.get_elem(f"{selector} .felt-browser-error-details")
            details_text = details.get_property("textContent").strip()
            assert error_msg_contains in details_text, (
                f"Expected '{error_msg_contains}' in error details: '{details_text}'"
            )

        self._driver.set_context("content")

    def test_felt_unreachable_ip_shows_connection_error(self):
        # Port 1 is on Firefox's blocked-port list, producing a generic "network"
        # error key that resolves to "Unknown network error" via the felt-error-network
        return self.check_error_bar_message(
            "http://127.0.0.1:1",
            ".felt-browser-error-connection",
            "Unable to connect",
            "Unknown network error",
        )

    def test_felt_nonexistent_domain_shows_no_network_error(self):
        # dnsNotFound2 which renders the no-network bar rather than the connection error bar.
        return self.check_error_bar_message(
            "http://nonexistent.localdomain:80",
            ".felt-browser-error-no-network",
            "No network connection",
            "Please check your internet connection and try again.",
        )

    def test_felt_ssl_mismatch_shows_connection_error(self):
        return self.check_error_bar_message(
            "https://wrong.host.badssl.com",
            ".felt-browser-error-connection",
            "Unable to connect",
        )

    def test_felt_error_details_include_console_address(self):
        # connectionFailure with host substitution so the console address appears in details.
        refused_port = self.console_port + 20000
        console_addr = f"https://localhost:{refused_port}"
        return self.check_error_bar_message(
            console_addr,
            ".felt-browser-error-connection",
            "Unable to connect",
            f"Firefox can’t establish a connection to the server at localhost:{refused_port}.",
        )
