#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import re
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment, decode_autoconfig
from felt_tests import FeltTests

# Placeholder marking a generic (non-repacked) build; keep in sync with
# ENTERPRISE_CONSOLE_PLACEHOLDER in nsXULAppAPI.h.
CONSOLE_ADDRESS_PLACEHOLDER = "FIREFOX_ENTERPRISE_GENERIC"

# Console address FELT resolves when the shipped AutoConfig file holds the
# placeholder; local builds are generic so this keeps the console setup dialog
# from blocking startup.
ENV_CONSOLE_ADDRESS = "https://console.autoconfig.example.com"


class FeltUpdatesAutoConfig(FeltTests):
    KEEP_AUTOCONFIG = True
    EXTRA_ENV = {"MOZ_ENTERPRISE_CONSOLE_URL": ENV_CONSOLE_ADDRESS}

    def test_felt_updates_autoconfig(self):
        self.run_verify_felt_app_update_url()
        # Browser is not being started in this test, so there is no need to
        # check for its proper close
        self._manually_closed_child = True

    def get_autoconfig_console_address(self):
        with open(self.get_autoconfig(self._driver), "rb") as cfg:
            source = decode_autoconfig(cfg.read())

        match = re.search(
            r'lockPref\(\s*"enterprise\.console\.address"\s*,\s*"([^"]*)"',
            source,
        )
        assert match, f"No console address in AutoConfig file:\n{source}"
        return match.group(1)

    def get_app_update_url(self, env):
        driver = self.get_driver(env)
        driver.set_context("chrome")
        rv = driver.execute_script("return Services.appinfo.updateURL;")
        driver.set_context("content")
        return rv

    def run_verify_felt_app_update_url(self):
        update_url = self.get_app_update_url(Environment.FELT)
        update_url_end = "api/browser/updates/%PRODUCT%/%VERSION%/%BUILD_ID%/%BUILD_TARGET%/%LOCALE%/%CHANNEL%/%OS_VERSION%/%SYSTEM_CAPABILITIES%/%DISTRIBUTION%/%DISTRIBUTION_VERSION%/update.xml"

        test_console_update_url = (
            f"http://localhost:{self.console_port}/{update_url_end}"
        )
        assert update_url != test_console_update_url, (
            f"FELT has Console-based update URL: {update_url} != {test_console_update_url}"
        )

        autoconfig_console_addr = self.get_autoconfig_console_address()
        if autoconfig_console_addr == CONSOLE_ADDRESS_PLACEHOLDER:
            # Generic build: the address comes from the environment override
            # (or the console setup dialog, out of scope here), not the cfg.
            autoconfig_console_addr = ENV_CONSOLE_ADDRESS
        autoconfig_console_update_url = f"{autoconfig_console_addr}/{update_url_end}"
        assert update_url == autoconfig_console_update_url, (
            f"FELT has Console-based update URL read from AutoConfig: {update_url} == {autoconfig_console_update_url}"
        )

        self._logger.info(
            f"Verified updateURL being read from AutoConfig: {update_url}"
        )
