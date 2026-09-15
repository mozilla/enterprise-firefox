#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_relaunch_deadline import BrowserRelaunchDeadlineBase


class BrowserRelaunchUpdateCheck(BrowserRelaunchDeadlineBase):
    EXTRA_PREFS = {
        "enterprise.felt_tests.should_not_close_window": True,
    }

    def test_console_deadline_checks_updates_while_browser_is_running(self):
        self.run_felt_base()
        self.connect_child_browser()
        browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._driver.set_context("chrome")
        self._driver.execute_script(
            """
            const { Updates } = ChromeUtils.importESModule(
              "resource://gre/modules/enterprise/Updates.sys.mjs"
            );
            window.updateChecks = 0;
            window.originalPrepareForRestart = Updates.prepareForRestart;
            Updates.prepareForRestart = async () => { window.updateChecks++; };
            """
        )
        try:
            self.serve_relaunch({"MinutesRemaining": 45})
            self._wait.until(
                lambda _: self._driver.execute_script(
                    "return window.updateChecks == 1;"
                ),
                message="The console deadline did not reach FELT's update handler",
            )
            self.serve_relaunch({"MinutesRemaining": 44})
            assert self._driver.execute_script("return window.updateChecks;") == 1
            self._child_driver.set_context("chrome")
            assert (
                self._child_driver.execute_script("return Services.appinfo.processID;")
                == browser_pid
            ), "Firefox stays running during update preparation"
        finally:
            self.serve_relaunch(None)
            self._driver.execute_script(
                """
                const { Updates } = ChromeUtils.importESModule(
                  "resource://gre/modules/enterprise/Updates.sys.mjs"
                );
                Updates.prepareForRestart = window.originalPrepareForRestart;
                """
            )
