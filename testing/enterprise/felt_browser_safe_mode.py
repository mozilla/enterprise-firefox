#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

from felt_safe_mode import SafeModeBase


class BrowserSafeModeBase(SafeModeBase):
    """
    Firefox-only checks of whether the browser runs in safe mode, as they open
    tabs and install Firefox add-ons. felt_safe_mode.py has generic checks that
    also work for Thunderbird.
    """

    def assert_about_support_safe_mode(self, expected):
        self.open_tab_child("about:support")

        safemode_box = self.get_elem_child("#safemode-box")
        self._child_wait.until(lambda d: len(safemode_box.text) > 0)
        self._logger.info(f"about:support safemode: {safemode_box.text}")
        expected_safemode_box = "true" if expected else "false"
        self._logger.info(f"expected safemode: {expected_safemode_box}")
        assert safemode_box.text == expected_safemode_box, (
            f"about:support should report safemode {expected_safemode_box}, was {safemode_box.text}"
        )

    def install_non_policy_addon(self):
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

    def get_browser_addons(self):
        """Returns a dict mapping each add-on name to whether it is active."""
        self._child_driver.set_context("chrome")
        addons = self._child_driver.execute_async_script(
            """
            const callback = arguments[arguments.length - 1];
            async function getAddons() {
              return (await AddonManager.getAllAddons()).map(addon => [addon.name, addon.isActive]);
            }
            getAddons().then(list => callback(list));
            """
        )
        self._child_driver.set_context("content")
        return dict(addons)

    def assert_addons_safe_mode(self, expected):
        # Tree Style Tab is force-installed by the ExtensionSettings policy once
        # the browser polls it.
        def both_installed(_):
            addons = self.get_browser_addons()
            if {"uBlock Origin", "Tree Style Tab"} <= addons.keys():
                return addons
            return None

        addons = self._child_longwait.until(
            both_installed,
            message="uBlock Origin and Tree Style Tab should both be installed",
        )

        if expected:
            assert not addons["uBlock Origin"], (
                "Non policy extensions should not be enabled in safe mode"
            )
        else:
            assert addons["uBlock Origin"], (
                "Non policy extensions should be enabled outside safe mode"
            )

        assert addons["Tree Style Tab"], "Policy extensions should be enabled"

    def assert_browser_safe_mode(self, expected):
        self._logger.info("Enable ExtensionSettings policy")
        self.policy_extensions.value = 1

        self.assert_child_safe_mode(expected)
        self.assert_about_support_safe_mode(expected)
        self.install_non_policy_addon()
        self.assert_addons_safe_mode(expected)

        self._logger.info("Disable ExtensionSettings policy")
        self.policy_extensions.value = 0
