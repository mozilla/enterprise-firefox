#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_browser_crashes import BrowserCrashes


class BrowserCrashRestart(BrowserCrashes):
    EXTRA_PREFS = {
        "enterprise.browser.abnormal_exit_limit": 2,
        "enterprise.browser.abnormal_exit_period": 1,
    }

    def test_browser_crash_abort_restart(self):
        super().run_felt_base()
        self.run_felt_crash_parent_once()
        self.run_felt_proper_restart()
        self.run_felt_crash_parent_twice()
        self.run_felt_proper_restart_again()

    def run_felt_proper_restart_again(self):
        self.run_felt_proper_restart()
