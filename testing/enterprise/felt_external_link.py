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


class BaseBrowserExternalLink(FeltTests):
    def run_felt_browser_started(self):
        self.connect_child_browser()

    def third_party_open_external_link(self):
        args = [
            f"{self._driver.instance.binary}",
            "-profile",
            self._driver.profile,
            self._external_link,
        ]
        subprocess.check_call(args, shell=False)

    def check_no_external_link_tab(self):
        tabs = self._child_driver.window_handles
        self._logger.info(f"Tabs before opening external link: {tabs}")

        has_tab = False
        for tab in tabs:
            self._child_driver.switch_to_window(tab)
            self._logger.info(f"Checking: {tab} => {self._child_driver.get_url()}")
            if self._child_driver.get_url().startswith(self._external_link):
                has_tab = True
                break

        assert not has_tab, f"Should not have {self._external_link} opened"
        return tabs

    def check_has_external_link_tab(self, tabs=None):
        if tabs is not None:
            self._child_wait.until(lambda mn: len(mn.window_handles) > len(tabs))

        has_new_tab = False
        loops = 0
        while not has_new_tab and loops < 30:
            for tab in self._child_driver.window_handles:
                self._child_driver.switch_to_window(tab)
                self._logger.info(
                    f"Checking new tabs: {tab} => {self._child_driver.get_url()}"
                )
                if self._child_driver.get_url().startswith(self._external_link):
                    has_new_tab = True
                    break
            loops += 1
            time.sleep(0.5)

        assert has_new_tab, f"Should have {self._external_link} opened"

    def run_felt_open_external_link(self):
        tabs = self.check_no_external_link_tab()
        self.third_party_open_external_link()
        self.check_has_external_link_tab(tabs)

    def run_open_about_pages(self):
        self._external_link = "about:buildconfig"
        self.check_has_external_link_tab()
        self._external_link = "about:logo"
        self.check_has_external_link_tab()
