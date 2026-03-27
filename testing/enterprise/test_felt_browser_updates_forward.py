#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests
from marionette_driver.errors import (
    JavascriptException,
)


class FeltUpdatesForward(FeltTests):
    EXTRA_PREFS = {
        "enterprise.felt_tests.should_not_close_window": True,
    }

    def install_update_manager_mock(self, ready_update=None):
        self._driver.set_context("chrome")
        self._driver.execute_script(
            """
            const UM = Cc["@mozilla.org/updates/update-manager;1"].getService(Ci.nsIUpdateManager);
            UM.internal.readyUpdate = {
                state: arguments[0],
                QueryInterface: ChromeUtils.generateQI(["nsIUpdate"]),
            };
        """,
            [ready_update],
        )
        self._driver.set_context("content")

    def test_felt_updates_forward(self):
        original_felt_pid = self._driver.session_capabilities["moz:processID"]
        self.run_felt_base()
        self.run_felt_browser_started()
        browser_pid = self._child_driver.session_capabilities["moz:processID"]

        # Using a context manager and using_prefs() would fail at shutdown time
        # because of FELT restarting in the end of the process
        self._driver.set_pref(
            "enterprise.felt_tests.should_not_close_window",
            False,
            default_branch=True,
        )

        # Update is still applying, so do not perform a FELT restart since
        # it is not ready yet to run the updater
        self.install_update_manager_mock("applying")
        self.run_felt_trigger_update()
        self.run_felt_click_browser_notification()
        # This is waiting on the browser to exit
        self._logger.info(f"Waiting on browser {browser_pid} restart")
        self.wait_process_exit(browser_pid)
        self._logger.info(f"Waited on browser {browser_pid} restart: done")
        self.run_felt_browser_started()

        # Next restart is for FELT so wait on it
        felt_pid = self._driver.session_capabilities["moz:processID"]
        assert original_felt_pid == felt_pid, (
            "FELT should not have restarted after browser restart and 'applying' state for update"
        )

        # Update is ready to run by the updater, perform a FELT restart
        self.install_update_manager_mock("applied")
        self.run_felt_trigger_update()
        self.run_felt_click_browser_notification()
        # This is waiting on FELT to restart
        self._logger.info(f"Waiting on FELT {felt_pid} restart")
        self.wait_process_exit(felt_pid)
        self._logger.info(f"Waited on FELT {felt_pid} restart: done")

        # Verify the restarted process
        self._driver.start_session()
        self._logger.info("Reconnected to FELT")

        new_felt_pid = self._driver.session_capabilities["moz:processID"]
        self._logger.info(f"Reconnected to FELT with {new_felt_pid}")
        assert original_felt_pid != new_felt_pid, (
            "FELT should have restarted after browser restart and 'applied' state for update"
        )

        self._driver.set_context("chrome")
        email = self.get_elem("#felt-form__email")
        assert email, "Found an email field for login page"

        mock_console = f"http://localhost:{self.console_port}"
        console_addr = self._driver.get_pref("enterprise.console.address")
        assert console_addr.startswith(mock_console), (
            f"Console in restarted FELT is mock: {mock_console}, found {console_addr}"
        )

        # Browser is not being started again
        self._manually_closed_child = True

        self._driver.execute_script(
            "Services.startup.quit(Ci.nsIAppStartup.eForceQuit);"
        )
        self.wait_process_exit(new_felt_pid)

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

    def run_felt_click_browser_notification(self):
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

        try:
            self._child_driver.set_context("chrome")
            self._child_driver.execute_script(
                """
                const { AppMenuNotifications } = ChromeUtils.importESModule("resource://gre/modules/AppMenuNotifications.sys.mjs");
                AppMenuNotifications.notifications.forEach(notification => {
                  console.debug(`FeltTests: notification: ${notification} => ${JSON.stringify(notification)}`);
                  if (notification.id === "update-restart") {
                    notification.mainAction.callback();
                  }
                });
                """
            )
            self._child_driver.set_context("content")
        except JavascriptException as ex:
            raise ex
        except Exception:
            # Exceptions here are expected since this triggers a restart
            pass
