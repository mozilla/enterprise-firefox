#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

import requests

sys.path.append(os.path.dirname(__file__))

from felt_browser_starts import FeltStartsBrowser


class FeltInsecureCerts(FeltStartsBrowser):
    def test_felt_browser_insecure_certs(self):
        requests.post(
            f"http://localhost:{self.console_port}/sso/login_force_wrong_location",
            data={"location": "https://wrong.host.badssl.com/sso_url"},
        )
        self.run_felt_base()
        self.run_felt_browser_started()

    def run_felt_load_sso(self):
        self._logger.info("Checking SSO page [SUPER]")
        self._driver.set_context("content")
        self._wait.until(lambda mn: mn.get_url().endswith("/sso_url"))
        self._logger.info(f"URL {self._driver.get_url()} [SUPER]")

        self._driver.set_context("chrome")
        rv = self._driver.execute_script(
            """
            const ssoBrowser = document.querySelector(".felt-login__sso browser");
            return ssoBrowser.browsingContext.currentURI.spec;
            """,
            [],
        )
        self._driver.set_context("content")
        self._logger.info(f"URI.spec {rv} [SUPER]")

    def run_felt_browser_started(self):
        self.open_tab_child(f"https://test.moz:{self.sso_port}/sso_page")
