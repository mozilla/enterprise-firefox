#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import shutil
import sys
import time

import mozversion
import requests

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class FeltUpdatesApplyFromFelt(FeltTests):
    EXTRA_PREFS = {
        "app.update.log": True,
        "app.update.disabledForTesting": False,
        "app.update.BITS.enabled": False,
        "enterprise.felt_tests.is_updates_testing": True,
        "enterprise.felt_tests.read_update_url_from_prefs": True,
    }

    def setup(self):
        self._logger.info("Enabling updates")
        version_info = mozversion.get_version(binary=self._driver.instance.binary)
        requests.post(
            f"http://localhost:{self.console_port}/api/browser/updates",
            data=version_info,
        )
        self._logger.info(f"Version: {version_info}")
        self._logger.info("Updates ready")
        super().setup()

    def get_update_config_file_path(self):
        self._driver.set_context("chrome")
        rv = self._driver.execute_script(
            """
            const { UpdateUtils } = ChromeUtils.importESModule("resource://gre/modules/UpdateUtils.sys.mjs");
            return UpdateUtils.getConfigFilePath();
            """
        )
        self._driver.set_context("content")
        return rv

    def test_felt_updates_apply_from_felt(self):
        self._update_root = os.path.dirname(self.get_update_config_file_path())

        self._logger.info("Updates ready: running tests")
        self.run_verify_update_ui()
        self.run_verify_update_check_run()
        # This is required since in marionette we use MAR that are not signed
        # so we cannot reach the real restart point
        # We also cannot close the window without loosing our Marionette access
        with self._driver.using_prefs({
            "enterprise.felt.previousBuildID": "20250701120000"
        }):
            self.reload_chrome_window()
            self.run_verify_update_applied()

    def teardown(self):
        self.run_updates_cleanup()

        self._logger.info("Disabling updates")
        requests.post(f"http://localhost:{self.console_port}/api/browser/updates")

        # We are not going to start the browser so do not try to close it
        self._manually_closed_child = True
        super().teardown()

    def run_verify_update_ui(self):
        self._logger.info("Checking update UI ...")
        self._driver.set_context("chrome")

        felt_login = self.find_elem(".felt-login")
        assert not felt_login.is_displayed(), "Login exists but is not displayed"

        felt_updates = self.get_elem(".felt-updates")
        assert felt_updates, "Update checking in progress"

        self._driver.set_context("content")
        self._logger.info("Checking update UI ... RUNNING")

    def run_verify_update_check_run(self):
        self._logger.info("Checking update run ...")
        self._driver.set_context("chrome")

        felt_updates_progress = self.get_elem("#felt-updates-progress")
        update_applied = False
        iterations = 0

        while not update_applied and iterations <= 50:
            update_level = felt_updates_progress.get_property("value")
            self._logger.info(f"Checking update run ... update_level={update_level}")
            update_applied = int(update_level) >= 90
            time.sleep(0.5)
            iterations += 1

        assert update_applied, "Update was applied"
        self._logger.info("Checking update run... APPLIED")

        self._driver.set_context("content")

    def run_verify_update_applied(self):
        self._logger.info("Checking update final ...")
        self._driver.set_context("chrome")

        felt_updates_finished = self.get_elem(".felt-updates-uptodate")
        assert felt_updates_finished, "Update finished dialog"

        self._driver.set_context("content")
        self._logger.info("Checking update final ... OK")

    def run_updates_cleanup(self):
        updates_dir = os.path.join(self._update_root, "updates")

        if os.path.isdir(updates_dir):
            shutil.rmtree(updates_dir)
