#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests


class FeltStartsBrowserMissingBin(FeltTests):
    def mock_services_felt_binPath(self):
        self._driver.set_context("chrome")
        self._driver.execute_script(
            """
            const originalServiceFelt = Services.felt;
            const MockServiceFelt = {
                binPath() {
                    const originalBinPath = originalServiceFelt.binPath();
                    console.debug(`Felt: Tests: mocked binPath() => ${originalBinPath}`);
                    return `${originalBinPath}.nonExistent`;
                },

              // Forward all other known methods explicitly
              ...Object.fromEntries(
                Object.keys(originalServiceFelt)
                    .filter(e => e !== "binPath")
                    .filter(e => e !== "QueryInterface")
                    .filter(e => typeof(Services.felt[e]) === "function")
                    .map(name => [
                  name,
                  originalServiceFelt[name].bind(originalServiceFelt),
                ])
              ),
            };
            Services.felt = MockServiceFelt;
            """
        )

    def test_felt_browser_start_missing_binary(self):
        # Browser is not being executed at all
        self._manually_closed_child = True
        self.mock_services_felt_binPath()
        self.run_felt_base()
        self.run_felt_check_error_message()

    def run_felt_check_error_message(self):
        self.await_felt_auth_window()
        self.force_window()
        self._driver.set_context("chrome")
        error_msg = self.get_elem(".felt-browser-error-launch-failure")
        assert "cannot start" in error_msg.text, (
            f"Error message about launch failure: {error_msg.text}"
        )
        self.maybe_save_screenshot(Environment.FELT, "launch_failure")
        self._logger.info("Launch failure properly reported")
