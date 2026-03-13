#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import subprocess
import sys

sys.path.append(os.path.dirname(__file__))

from test_felt_browser_new_window_from_cli import FeltNewWindowFromCli


class FeltRapidNewWindowsFromCli(FeltNewWindowFromCli):
    def test_rapid_new_windows_from_cli(self):
        """Rapidly open multiple windows via CLI to detect races in URL
        queuing / dock icon handling (see bug 2002462 comment 18)."""
        super().run_felt_base()
        self.connect_child_browser()

        NUM_WINDOWS = 5
        windows = self._get_child_windows()
        initial_count = len(windows)
        base_url = f"http://localhost:{self.console_port}/ping"

        procs = []
        for i in range(NUM_WINDOWS):
            url = f"{base_url}?rapid={i}"
            args = [
                f"{self._driver.instance.binary}",
                "-profile",
                self._child_profile_path,
                "--new-window",
                url,
            ]
            procs.append(subprocess.Popen(args, shell=False))

        for proc in procs:
            proc.wait(timeout=30)

        expected_count = initial_count + NUM_WINDOWS
        windows = self._wait_for_exact_window_count(expected_count)

        rapid_urls = [w["url"] for w in windows if f"{base_url}?rapid=" in w["url"]]
        assert len(rapid_urls) == NUM_WINDOWS, (
            f"Expected {NUM_WINDOWS} rapid-opened windows, "
            f"found {len(rapid_urls)}: {rapid_urls}"
        )
        assert len(set(rapid_urls)) == NUM_WINDOWS, (
            f"Found duplicate URLs in rapid-opened windows: {rapid_urls}"
        )
