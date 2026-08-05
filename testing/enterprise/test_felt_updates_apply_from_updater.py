#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

import mozversion
import requests

sys.path.append(os.path.dirname(__file__))

from felt_updates import FeltUpdatesBase


class FeltUpdatesApplyFromUpdater(FeltUpdatesBase):
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

    def teardown(self):
        self.run_updates_cleanup()

        self._logger.info("Disabling updates")
        requests.post(f"http://localhost:{self.console_port}/api/browser/updates")

        super().teardown()

    def test_felt_updates_apply_from_updater(self):
        self.run_felt_updates_apply()

        # This is required since in marionette we use MAR that are not signed
        # so we cannot reach the real restart point
        # We also cannot close the window without loosing our Marionette access
        with self._driver.using_prefs({
            "enterprise.felt.previousBuildID": "20250701120000"
        }):
            self.reload_chrome_window()
            expected_start = f"http://localhost:{self.console_port}/downloads/"
            expected_end = "complete.mar"
            self.assert_latest_update_url("failed", expected_start, expected_end)
            self.run_verify_update_applied()
