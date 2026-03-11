#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class FeltDevicePostureExtensions(FeltTests):
    """Verify that force-installed extensions appear in device posture."""

    def test_device_posture_includes_extensions(self):
        self.policy_extensions.value = 1
        super().run_felt_base()
        self.connect_child_browser()
        self.wait_for_extension_installed()
        self.run_device_posture_extensions()

    def wait_for_extension_installed(self):
        self._child_driver.set_context("chrome")
        self._child_longwait.until(
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

    def get_device_posture_from_child(self):
        self._child_driver.set_context("chrome")
        try:
            return self._child_driver.execute_async_script(
                """
                const callback = arguments[arguments.length - 1];
                const { ConsoleClient } = ChromeUtils.importESModule(
                  "resource://gre/modules/enterprise/ConsoleClient.sys.mjs"
                );
                ConsoleClient.collectDevicePosture()
                  .then(callback)
                  .catch(err => callback({_error: String(err)}));
                """,
            )
        finally:
            self._child_driver.set_context("content")

    def run_device_posture_extensions(self):
        posture = self.get_device_posture_from_child()
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
