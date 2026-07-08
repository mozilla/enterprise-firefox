#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests


class FeltDevicePostureExtensions(FeltTests):
    """Verify that force-installed extensions appear in device posture."""

    def test_device_posture_includes_extensions(self):
        self.policy_extensions.value = 1
        self.get_driver(Environment.FELT).set_prefs(
            {"enterprise.felt_tests.should_not_close_window": True},
            default_branch=True,
        )
        super().run_felt_base()
        self.connect_child_browser()

        assert self.wait_for_extension_installed(), "Extension not installed"
        self.run_device_posture_extensions(Environment.FIREFOX)
        self.run_device_posture_extensions(Environment.FELT)


    def wait_for_extension_installed(self):
        self._child_driver.set_context("chrome")
        rv = self._child_longwait.until(
            lambda _: self._child_driver.execute_async_script(
                """
            const callback = arguments[arguments.length - 1];
            const { AddonManager } = ChromeUtils.importESModule(
              "resource://gre/modules/AddonManager.sys.mjs"
            );
            AddonManager.getAddonByID("treestyletab@piro.sakura.ne.jp")
              .then(addon => callback(addon !== null))
              .catch(() => callback(false));
            """,
            )
        )
        self._child_driver.set_context("content")
        return rv

    def get_device_posture(self, env):
        driver = self.get_driver(env)
        driver.set_context("chrome")
        try:
            return driver.execute_async_script(
                """
                const callback = arguments[arguments.length - 1];
                const { DevicePosture } = ChromeUtils.importESModule(
                  "resource://gre/modules/enterprise/DevicePosture.sys.mjs"
                );
                DevicePosture.collect()
                  .then(callback)
                  .catch(err => callback({_error: String(err)}));
                """,
            )
        finally:
            driver.set_context("content")

    def run_device_posture_extensions(self, env):
        posture = self.get_device_posture(env)
        assert "_error" not in posture, (
            f"Failed to collect device posture: {posture.get('_error')}"
        )

        extensions = posture["extensions"]
        assert isinstance(extensions, list), "Extensions is a list"
        assert len(extensions) >= 1, "At least one extension reported in device posture"

        ext_ids = [e["id"] for e in extensions]
        assert "treestyletab@piro.sakura.ne.jp" in ext_ids, (
            "Force-installed Tree Style Tab extension appears in device posture"
        )

        tst = next(e for e in extensions if e["id"] == "treestyletab@piro.sakura.ne.jp")
        assert tst["name"] == "Tree Style Tab", (
            f"Extension display name is 'Tree Style Tab', got '{tst['name']}'"
        )
        assert tst["type"] == "extension", (
            f"Extension type is 'extension', got '{tst['type']}'"
        )
        assert len(tst["version"]) > 0, "Extension has a version string"
        assert tst["enabled"] is True, "Force-installed extension is enabled"
