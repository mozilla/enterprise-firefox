#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import subprocess
import sys

sys.path.append(os.path.dirname(__file__))

from test_felt_browser_new_window_from_cli import FeltNewWindowFromCli


class FeltRapidNewTabsFromCli(FeltNewWindowFromCli):
    def test_rapid_new_tabs_from_cli(self):
        """Rapidly open multiple tabs via CLI to detect races when URLs
        are opened in existing windows (see bug 2002462 comment 18)."""
        super().run_felt_base()
        self.connect_child_browser()

        NUM_TABS = 5
        base_url = f"http://localhost:{self.console_port}/ping"

        procs = []
        for i in range(NUM_TABS):
            url = f"{base_url}?tab={i}"
            args = [
                f"{self._driver.instance.binary}",
                "-profile",
                self._child_profile_path,
                "-url",
                url,
            ]
            procs.append(subprocess.Popen(args, shell=False))

        for proc in procs:
            proc.wait(timeout=30)

        matching = self._wait_for_tab_urls_containing(f"{base_url}?tab=", NUM_TABS)
        assert len(set(matching)) == NUM_TABS, (
            f"Found duplicate URLs in rapid-opened tabs: {matching}"
        )
