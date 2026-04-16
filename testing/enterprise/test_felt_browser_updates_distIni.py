#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import configparser
import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests


class FeltUpdatesDistIni(FeltTests):
    KEEP_DISTRIBUTION_INI = True

    def test_felt_updates_dist_ini(self):
        self.run_verify_felt_app_update_url()
        # Browser is not being started in this test, so there is no need to
        # check for its proper close
        self._manually_closed_child = True

    def get_distribution_ini_console_address(self):
        dist_ini = self.get_distribution_ini(self._driver)
        ini = configparser.ConfigParser()
        ini.read(dist_ini)
        return ini["Preferences"]["enterprise.console.address"]

    def get_app_update_url(self, env):
        driver = self.get_driver(env)
        driver.set_context("chrome")
        rv = driver.execute_script("return Services.appinfo.updateURL;")
        driver.set_context("content")
        return rv

    def run_verify_felt_app_update_url(self):
        test_pref = self._driver.get_pref(
            "enterprise.felt_tests.read_update_url_from_prefs"
        )
        assert not test_pref, "Test pref for update url is not set"

        update_url = self.get_app_update_url(Environment.FELT)
        update_url_end = "api/browser/updates/%PRODUCT%/%VERSION%/%BUILD_ID%/%BUILD_TARGET%/%LOCALE%/%CHANNEL%/%OS_VERSION%/%SYSTEM_CAPABILITIES%/%DISTRIBUTION%/%DISTRIBUTION_VERSION%/update.xml"

        test_console_update_url = (
            f"http://localhost:{self.console_port}/{update_url_end}"
        )
        assert update_url != test_console_update_url, (
            f"FELT has Console-based update URL: {update_url} != {test_console_update_url}"
        )

        dist_ini_console_addr = self.get_distribution_ini_console_address()
        dist_ini_console_update_url = f"{dist_ini_console_addr}/{update_url_end}"
        assert update_url == dist_ini_console_update_url, (
            f"FELT has Console-based update URL read from distribution.ini: {update_url} == {dist_ini_console_update_url}"
        )

        self._logger.info(
            f"Verified updateURL being read from distribution ini: {update_url}"
        )
