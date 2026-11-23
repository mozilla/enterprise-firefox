#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import sys
import time

from marionette_driver.by import By

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests

ERROR_BARS = ".felt-browser-error moz-message-bar"
SETTLE_SECONDS = 3


class FeltSubframeError(FeltTests):
    """
    A subframe of the SSO page that fails to load must not affect the FELT
    login chrome: the SSO pane stays visible and no error bar is shown.
    """

    def teardown(self):
        # Authentication never completes, so no child browser is launched.
        self._manually_closed_child = True
        super().teardown()

    def _displayed(self, selector):
        return self.find_elem(selector).is_displayed()

    def _subframe_document_uri(self):
        return self._driver.execute_script(
            'return document.getElementById("browser").browsingContext'
            '.children[0]?.currentWindowGlobal?.documentURI.spec ?? "";'
        )

    def test_felt_subframe_neterror_is_ignored(self):
        self.login_location.value = (
            f"http://localhost:{self.sso_port}/sso_url_failing_iframe"
        )
        self.submit_email()

        self._driver.set_context("chrome")
        self._wait.until(
            lambda _: self._subframe_document_uri().startswith("about:neterror"),
            message="The SSO page's iframe loads an error page",
        )

        # The error report is sent asynchronously once the error page loads.
        time.sleep(SETTLE_SECONDS)
        assert self._displayed(".felt-login__sso"), "SSO pane stays visible"
        assert not self._displayed(".felt-login__email-pane"), "Email pane stays hidden"
        assert self._displayed("#felt-back-button"), "Back button stays visible"
        shown = [
            bar.get_attribute("class")
            for bar in self._driver.find_elements(By.CSS_SELECTOR, ERROR_BARS)
            if bar.is_displayed()
        ]
        assert not shown, f"No error bar is shown for a subframe error: {shown}"
        self._driver.set_context("content")
