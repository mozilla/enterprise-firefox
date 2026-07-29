#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class FeltUpdatesForwardOffline(FeltTests):
    EXTRA_PREFS = {
        "network.disable-localhost-when-offline": True,
        "network.manage-offline-status": False,
    }

    def set_offline(self, value):
        self._driver.set_context("chrome")
        self._driver.execute_script(
            """
            Services.io.offline = arguments[0];
            """,
            [value],
        )
        self._driver.set_context("content")

    def test_felt_updates_forward(self):
        self.set_offline(True)
        self.submit_email()

        self._logger.info("Checking offline")
        self._driver.set_context("chrome")
        error = self.get_elem(".felt-browser-error-no-network")
        self._logger.info(f"Checking offline: error={error}")
        self._wait.until(
            lambda d: (
                h.strip()
                if (h := error.get_attribute("heading"))
                and "No network connection" in h.strip()
                else False
            )
        )
        self._logger.info("Checking offline: OK. Going back online")
        self.set_offline(False)

        self._logger.info("Online, update applied in background before browser starts")
        self.run_felt_trigger_update()

        self._logger.info("Run SSO and start browser")
        self.run_felt_base()

        self._logger.info("Connect to launched browser")
        self.run_felt_browser_started()

        self._logger.info("Verify existence of update notification")
        self.run_felt_find_browser_notification()

    def run_felt_browser_started(self):
        self.connect_child_browser()
        self.open_tab_child("about:support")

    def run_felt_trigger_update(self):
        self._driver.set_context("chrome")
        self._driver.execute_script(
            """
            Services.obs.notifyObservers(null, "update-downloaded", "applied-service");
            """
        )
        self._driver.set_context("content")

    def run_felt_find_browser_notification(self):
        self._child_driver.set_context("chrome")
        notifications = self._child_driver.execute_script(
            """
            const { AppMenuNotifications } = ChromeUtils.importESModule("resource://gre/modules/AppMenuNotifications.sys.mjs");
            return AppMenuNotifications.notifications;
            """
        )
        self._child_driver.set_context("content")

        found_update_ready = False
        for notification in notifications:
            if notification["id"] == "update-restart":
                found_update_ready = True
                break

        assert found_update_ready, "Found an update-restart notification"
