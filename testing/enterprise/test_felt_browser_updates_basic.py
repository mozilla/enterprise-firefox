#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests


class FeltUpdatesBasicChecks(FeltTests):
    def test_felt_updates_basic_checks(self):
        self.run_felt_chrome_on_email_submit()
        self.run_verify_felt_app_update_url()
        self.run_wait_until_sso_loaded()
        self.run_felt_perform_sso_auth()
        self.connect_child_browser()
        self.run_verify_browser_app_update_url()
        self.run_verify_browser_prefs()

    def get_app_update_url(self, env):
        driver = self.get_driver(env)
        driver.set_context("chrome")
        rv = driver.execute_script("return Services.appinfo.updateURL;")
        driver.set_context("content")
        return rv

    def get_app_update_prefs(self, env):
        prefs = [
            "app.update.auto",
            "app.update.channel",
            "app.update.checkOnlyInstance.enabled",
            "app.update.background.enabled",
            "app.update.staging.enabled",
        ]

        driver = self.get_driver(env)
        final_rv = {}
        for pref in prefs:
            final_rv[pref] = driver.get_pref(pref, default_branch=True)

        return final_rv

    def run_verify_felt_app_update_url(self):
        update_url = self.get_app_update_url(Environment.FELT)
        expected_update_url = f"http://localhost:{self.console_port}/api/browser/updates/%PRODUCT%/%VERSION%/%BUILD_ID%/%BUILD_TARGET%/%LOCALE%/%CHANNEL%/%OS_VERSION%/%SYSTEM_CAPABILITIES%/%DISTRIBUTION%/%DISTRIBUTION_VERSION%/update.xml"
        assert update_url == expected_update_url, (
            f"FELT has Console-based update URL: {update_url} == {expected_update_url}"
        )

    def run_verify_browser_app_update_url(self):
        update_url = self.get_app_update_url(Environment.FIREFOX)
        assert update_url == "", f"Browser has empty update URL: {update_url}"

    def run_verify_browser_prefs(self):
        prefs = self.get_app_update_prefs(Environment.FIREFOX)

        assert prefs["app.update.auto"], "Auto updates enabled"
        # TODO: Do we care about the update channel ? The update URL is already
        # controlled ...
        # assert prefs["app.update.channel"] == "", "No update channel"
        assert not prefs["app.update.checkOnlyInstance.enabled"], (
            "Check only instance is disabled"
        )
        assert prefs["app.update.background.enabled"], "Background updates enabled"
        assert prefs["app.update.staging.enabled"], "Staging of updates enabled"
