#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import sys

from felt_browser_starts import FeltStartsBrowser


class FeltStartsBrowserSafeMode(FeltStartsBrowser):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def test_felt_00_chrome_on_email_submit(self, exp):
        self._driver.set_context("chrome")
        safe_mode_felt = self._driver.execute_script(
            "return Services.appinfo.inSafeMode;"
        )
        self._driver.set_context("content")

        assert safe_mode_felt is False, "FELT should report not in safe mode"

        return super().test_felt_00_chrome_on_email_submit(exp)

    def test_felt_3_browser_started(self, exp):
        self.connect_child_browser()
        self._child_driver.set_context("chrome")
        safe_mode_browser = self._child_driver.execute_script(
            "return Services.appinfo.inSafeMode;"
        )
        self._child_driver.set_context("content")
        assert safe_mode_browser is True, "Browser should report in safe mode"

        self._logger.info("Enable ExtensionSettings policy")
        self.policy_extensions.value = 1

        return True

    def test_felt_4_verify_prefs(self, exp):
        """
        Prefs are not important for this test but let us reuse FeltStartsBrowser
        """
        return True

    def test_felt_5_about_support_safe_mode(self, exp):
        self.open_tab_child("about:support")

        safemode_box = self.get_elem_child("#safemode-box")
        self._child_wait.until(lambda d: len(safemode_box.text) > 0)
        self._logger.info(f"about:support safemode: {safemode_box.text}")
        self._logger.info(f"expected safemode: {exp['safemode_box']}")
        assert safemode_box.text == exp["safemode_box"], (
            f"about:support should report safemode true, was {safemode_box.text}"
        )

        return True

    def test_felt_6_install_addon_classic(self, exp):
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
        return True

    def test_felt_7_install_addon_policy(self, exp):
        return True

    def test_felt_8_assert_addons(self, exp):
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

        return True


if __name__ == "__main__":
    FeltStartsBrowserSafeMode(
        "felt_browser_safe_mode.json",
        firefox=sys.argv[1],
        geckodriver=sys.argv[2],
        profile_root=sys.argv[3],
        cli_args=["--safe-mode"],
    )
