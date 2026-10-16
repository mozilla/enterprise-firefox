#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

from felt_browser_starts import FeltStartsBrowser


class BrowserSafeMode(FeltStartsBrowser):
    """
    Checks of whether the browser child runs in safe mode. The add-on checks
    expect the ExtensionSettings policy (policy_extensions) to be served.
    """

    def assert_child_safe_mode(self, expected):
        self._child_driver.set_context("chrome")
        safe_mode_browser = self._child_driver.execute_script(
            "return Services.appinfo.inSafeMode;"
        )
        self._child_driver.set_context("content")
        assert safe_mode_browser is expected, (
            f"Browser should report inSafeMode {expected}, was {safe_mode_browser}"
        )

    def run_felt_about_support_safe_mode(self, expected):
        self.open_tab_child("about:support")

        safemode_box = self.get_elem_child("#safemode-box")
        self._child_wait.until(lambda d: len(safemode_box.text) > 0)
        self._logger.info(f"about:support safemode: {safemode_box.text}")
        expected_safemode_box = "true" if expected else "false"
        self._logger.info(f"expected safemode: {expected_safemode_box}")
        assert safemode_box.text == expected_safemode_box, (
            f"about:support should report safemode {expected_safemode_box}, was {safemode_box.text}"
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

    def get_addons_child(self):
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

    def run_felt_assert_addons(self, expected_safe_mode):
        # Tree Style Tab is force-installed by the ExtensionSettings policy once
        # the browser polls it.
        def both_installed(_):
            addons = self.get_addons_child()
            if {"uBlock Origin", "Tree Style Tab"} <= addons.keys():
                return addons
            return None

        addons = self._child_longwait.until(
            both_installed,
            message="uBlock Origin and Tree Style Tab should both be installed",
        )

        if expected_safe_mode:
            assert not addons["uBlock Origin"], (
                "Non policy extensions should not be enabled in safe mode"
            )
        else:
            assert addons["uBlock Origin"], (
                "Non policy extensions should be enabled outside safe mode"
            )

        assert addons["Tree Style Tab"], "Policy extensions should be enabled"

    def run_felt_assert_safe_mode(self, expected):
        self.assert_child_safe_mode(expected)
        self.run_felt_about_support_safe_mode(expected)
        self.run_felt_install_addon_classic()
        self.run_felt_assert_addons(expected)
