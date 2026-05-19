#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import subprocess
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class FeltQueuesExternalLink(FeltTests):
    def test_self_external_link(self):
        # We do not start a browser
        self._manually_closed_child = True
        self._external_link = f"http://localhost:{self.console_port}/ping"
        self.run_felt_open_external_link()

    def get_focus_was_requested(self):
        return self._driver.execute_script(
            """
            return window.focusWasRequested;
            """
        )

    def run_felt_open_external_link(self):
        self._driver.set_context("chrome")
        self._driver.execute_script(
            """
            console.debug(`FeltTests: run_felt_open_external_link(): originalFocus`);
            const originalFocus = window.focus.bind(window);
            window.focusWasRequested = false;

            console.debug(`FeltTests: run_felt_open_external_link(): window.focus() override`);
            window.focus = function(...args) {
              console.debug(`FeltTests: run_felt_open_external_link(): window.focus() override calls original`);
              window.focusWasRequested = true;
              return originalFocus(...args);
            };
            """
        )
        assert not self.get_focus_was_requested(), "Window requested focus"
        self._logger.info(
            "Window did not request focus, trying to open link from external app"
        )

        args = [
            f"{self._driver.instance.binary}",
            "-profile",
            self._driver.profile,
            self._external_link,
        ]
        subprocess.check_call(args, shell=False)

        self._wait.until(lambda mn: self.get_focus_was_requested() is True)
        self._logger.info("Window did request focus")
