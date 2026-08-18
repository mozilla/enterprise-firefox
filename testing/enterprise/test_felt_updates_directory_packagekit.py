#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class FeltUpdatesDirectoryPackageKit(FeltTests):
    EXTRA_PREFS = {
        "app.update.use_package_kit": True,
        "app.update.disabledForTesting": True,
    }

    def test_felt_updates_directory_packagekit(self):
        # We are not going to start the browser so do not try to close it
        self._manually_closed_child = True
        self.run_verify_update_directory()

    def run_verify_update_directory(self):
        self._logger.info("Checking update directory")
        self._driver.set_context("chrome")
        binary_root = os.path.dirname(self._driver.instance.binary)
        update_config = self._driver.execute_script(
            """
            const { UpdateUtils } = ChromeUtils.importESModule("resource://gre/modules/UpdateUtils.sys.mjs");
            return UpdateUtils.getConfigFilePath();
            """
        )
        update_root = os.path.dirname(update_config)
        assert (
            update_root != binary_root
            and ".cache/mozilla" in update_root
        ), (
            f"Update directory with PackageKit is the binary directory: update_root={update_root} -- binary_root={binary_root}"
        )
        self._logger.info(f"Checking update directory is correct: {update_root}")
        self._driver.set_context("content")
