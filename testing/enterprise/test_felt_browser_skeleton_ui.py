#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from test_felt_browser_signout import BaseBrowserSignout


class BrowserSkeletonUI(BaseBrowserSignout):
    def test_skeleton_ui_not_shown_for_felt(self):
        self.run_check_skeleton_ui(self._driver, expected=False)

        super().run_felt_base()
        self.connect_child_browser(
            capabilities={
                # Do not auto-handle prompts.
                "unhandledPromptBehavior": "ignore"
            }
        )
        # Skeleton UI is not shown for the child browser either, which is
        # expected since we use FELT and don't need it.
        self.run_check_skeleton_ui(self._child_driver, expected=False)
        self._do_signout()

        self._logger.info("Restarting felt out-of-process")
        self.marionette.restart(in_app=False)
        self._logger.info("Felt restarted")
        self.run_check_skeleton_ui(self._driver, expected=False)
        self._manually_closed_child = True

    def run_check_skeleton_ui(self, driver, expected):
        with driver.using_context(driver.CONTEXT_CHROME):
            showed = driver.execute_script(
                "return Services.startup.showedPreXULSkeletonUI;"
            )
        self._logger.info(f"showedPreXULSkeletonUI: {showed}")

        assert showed == expected, (
            f"Expected showedPreXULSkeletonUI to be {expected}, got {showed}"
        )
