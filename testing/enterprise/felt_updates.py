#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import shutil
import sys
import time

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class FeltUpdatesBase(FeltTests):
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

    def get_latest_update_from_history(self):
        with self._driver.using_context(self._driver.CONTEXT_CHROME):
            result = self._driver.execute_async_script("""
            const callback = arguments[arguments.length - 1];
            Cc["@mozilla.org/updates/update-manager;1"]
              .getService(Ci.nsIUpdateManager)
              .getHistory()
              .then(history => callback(history[0]))
              .catch(err => callback({ error: err.toString() }));
            """)

        assert "error" not in result, f"UpdateManager failed: {result.get('error')}"
        return result

    def assert_latest_update_url(self, state, expected_start, expected_end):
        update_data = self.get_latest_update_from_history()

        assert update_data is not None, "Update data payload is missing."
        assert update_data["state"] == state, (
            f"Update state {update_data['state']} is not the expected state {state}"
        )

        patch = update_data.get("selectedPatch", {})
        assert patch is not None, "The update history entry does not contain any patch."

        url = patch.get("URL")
        # Split query string that does not matter
        final_url = patch.get("finalURL").split("?")[0]

        assert url is not None, "Patch is missing a URL descriptor."
        assert url == final_url, (
            f"URL mismatch: '{url}' does not equal finalURL '{final_url}'."
        )
        assert url.startswith(expected_start), (
            f"Expected URL to start with '{expected_start}', but got '{url}'."
        )
        assert url.endswith(expected_end), (
            f"Expected URL to end with '{expected_end}', but got '{url}'."
        )

    def run_felt_updates_apply(self):
        # We are not going to start the browser so do not try to close it
        self._manually_closed_child = True

        self._update_root = os.path.dirname(self.get_update_config_file_path())

        self._logger.info("Updates ready: running tests")
        self.run_verify_update_ui()
        self.run_verify_update_check_run()

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
