#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import subprocess
import sys
import time

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class FeltNewWindowFromCli(FeltTests):
    def _get_child_windows(self):
        # We use execute_script rather than Selenium/Marionette's window APIs because
        # WebDriver doesn't expose whether a window is private. PrivateBrowsingUtils
        # is the only reliable way to check this.
        self._child_driver.set_context("chrome")
        windows = self._child_driver.execute_script(
            """
            const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
              "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
            );
            let results = [];
            let enumerator = Services.wm.getEnumerator("navigator:browser");
            while (enumerator.hasMoreElements()) {
              let win = enumerator.getNext();
              results.push({
                url: win.gBrowser?.currentURI?.spec ?? "",
                isPrivate: PrivateBrowsingUtils.isWindowPrivate(win),
              });
            }
            return results;
            """
        )
        self._child_driver.set_context("content")
        return windows

    def _wait_for_window_count(self, expected):
        loops = 0
        while loops < 40:
            windows = self._get_child_windows()
            if len(windows) >= expected:
                return windows
            loops += 1
            time.sleep(0.5)
        assert False, f"Expected {expected} windows, saw {len(windows)}"

    def _wait_for_window_with_url(self, url, is_private=None):
        loops = 0
        while loops < 40:
            windows = self._get_child_windows()
            for win in windows:
                if win["url"].startswith(url):
                    if is_private is None or win["isPrivate"] == is_private:
                        return windows
            loops += 1
            time.sleep(0.5)
        assert False, f"Expected window with url {url}"

    def test_new_window_from_cli(self):
        super().run_felt_base()
        self.connect_child_browser()
        self.run_felt_open_new_window_from_cli()
        self.run_felt_open_private_window_from_cli()

    def run_felt_open_new_window_from_cli(self):
        url = f"http://localhost:{self.console_port}/ping"
        windows = self._get_child_windows()
        initial_count = len(windows)
        args = [
            f"{self._driver.instance.binary}",
            "-profile",
            self._child_profile_path,
            "--new-window",
            url,
        ]
        subprocess.check_call(args, shell=False)

        self._wait_for_window_count(initial_count + 1)
        self._wait_for_window_with_url(url, is_private=False)

    def run_felt_open_private_window_from_cli(self):
        url = f"http://localhost:{self.sso_port}/sso_url"
        windows = self._get_child_windows()
        initial_count = len(windows)
        args = [
            f"{self._driver.instance.binary}",
            "-profile",
            self._child_profile_path,
            "--private-window",
            url,
        ]
        subprocess.check_call(args, shell=False)

        self._wait_for_window_count(initial_count + 1)
        self._wait_for_window_with_url(url, is_private=True)
