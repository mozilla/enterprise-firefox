#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_browser_starts import FeltStartsBrowser


class FeltStartsBrowserSafeMode(FeltStartsBrowser):
    def setUp(self):
        self._extra_cli_args = ["--safe-mode"]
        super().setUp()

    def test_felt_starts_browser_safe_mode(self):
        self._driver.set_context("chrome")
        safe_mode_felt = self._driver.execute_script(
            "return Services.appinfo.inSafeMode;"
        )
        self._driver.set_context("content")

        assert safe_mode_felt is False, "FELT should report not in safe mode"

        super().run_felt_base()
        self.run_felt_browser_started()
        self.run_felt_about_support_safe_mode()
        self.run_felt_install_addon_classic()
        self.run_felt_assert_addons()

    def run_felt_browser_started(self):
        self.connect_child_browser()
        self._child_driver.set_context("chrome")
        safe_mode_browser = self._child_driver.execute_script(
            "return Services.appinfo.inSafeMode;"
        )
        self._child_driver.set_context("content")
        assert safe_mode_browser is True, "Browser should report in safe mode"

        self._logger.info("Enable ExtensionSettings policy")
        self.policy_extensions.value = 1

    def run_felt_about_support_safe_mode(self):
        self.open_tab_child("about:support")

        safemode_box = self.get_elem_child("#safemode-box")
        self._child_wait.until(lambda d: len(safemode_box.text) > 0)
        self._logger.info(f"about:support safemode: {safemode_box.text}")
        expected_safemode_box = "true"
        self._logger.info(f"expected safemode: {expected_safemode_box}")
        assert safemode_box.text == expected_safemode_box, (
            f"about:support should report safemode true, was {safemode_box.text}"
        )

    def run_felt_install_addon_classic(self):
        self._child_driver.set_context("chrome")
        addon = self._child_driver.execute_async_script(
            f"""
            const callback = arguments[arguments.length - 1];
            async function installAddon() {{
                let ublock = await AddonManager.getInstallForURL('http://localhost:{self.console_port}/downloads/ublock_origin-1.67.0.xpi');
                return await ublock.install();
            }};

            installAddon().then(addon => {{
              callback(addon);
            }}).catch(err => {{
              callback({{"err": err}});
            }});
            """
        )
        self._child_driver.set_context("content")
        assert addon["id"] == "uBlock0@raymondhill.net", "uBlock Origin addon installed"

    def run_felt_assert_addons(self):
        self._child_driver.set_context("chrome")
        addons = self._child_driver.execute_async_script(
            """
            const callback = arguments[arguments.length - 1];
            async function getAddons() {{
              return (await AddonManager.getAllAddons()).map(addon => [addon.name, addon.isActive]);
            }}
            getAddons().then(list => callback(list));
            """
        )
        self._child_driver.set_context("content")

        for [name, enabled] in addons:
            if name == "uBlock Origin":
                assert not enabled, (
                    "Non policy extensions should not be enabled in safe mode"
                )

            if name == "Tree Style Tab":
                assert enabled, "Policy extensions should be enabled in safe mode"

        self._logger.info("Disable ExtensionSettings policy")
        self.policy_extensions.value = 0
