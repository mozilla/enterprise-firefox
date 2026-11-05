#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_relaunch_deadline import WARNING_ID, BrowserRelaunchDeadlineBase


class BrowserRelaunchDeadlineRemovedBar(BrowserRelaunchDeadlineBase):
    def test_relaunch_deadline_returns_after_the_bar_is_removed(self):
        self.run_felt_base()
        self.connect_child_browser()

        self.serve_relaunch({"MinutesRemaining": 45})
        assert self.wait_for_relaunch_bar() == WARNING_ID, (
            "Expected the warning bar for a comfortable restart budget"
        )

        self._logger.info("Something else removes the bar")
        self.remove_relaunch_bar()
        # removeNotification() takes the bar out of the box asynchronously.
        self._child_wait.until(
            lambda _: self.relaunch_bar() is None,
            message="The bar is still up",
        )

        # A refresh deriving the same text as the removed bar, as a poll does
        # once the console decrements the budget in step with real time.
        self.refresh_relaunch_bar()
        assert self.relaunch_bar() == WARNING_ID, (
            "A later refresh did not put the warning bar back"
        )

    def refresh_relaunch_bar(self):
        self._child_driver.set_context("chrome")
        self._child_driver.execute_async_script(
            """
            const resolve = arguments[arguments.length - 1];
            const { RelaunchEnforcer } = ChromeUtils.importESModule(
              "moz-src:///toolkit/components/enterprise/modules/RelaunchEnforcer.sys.mjs"
            );
            RelaunchEnforcer._refreshNotification().then(() => resolve(true));
            """
        )

    def remove_relaunch_bar(self):
        """Removes the relaunch bar the way InfoBar evicts an incumbent."""
        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            """
            const { InfoBar } = ChromeUtils.importESModule(
              "resource:///modules/asrouter/InfoBar.sys.mjs"
            );
            InfoBar._activeInfobar.notification.removeUniversalInfobars();
            """
        )
