#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests


class FeltUpdatesErrorHandling(FeltTests):
    EXTRA_PREFS = {
        "enterprise.felt_tests.read_update_url_from_prefs": True,
    }

    def reload_chrome_window(self):
        self._driver.set_context("chrome")
        self._driver.execute_script(
            """
            window.location.reload();
            """
        )
        # Ensure document is ready when we finish this. Making reload in the same
        # script does not work well, document gets unloaded and Marionette is
        # unhappy.
        self._driver.execute_async_script(
            """
            let done = arguments[0];
            if (document.readyState === "complete") {
                done();
            } else {
                window.addEventListener("load", () => done(), { once: true });
            }
            """
        )
        self._driver.set_context("content")

    def trigger_appUpdater_error(self, error):
        self._driver.set_context("chrome")
        self._driver.execute_script(
            """
            const { AppUpdater } = ChromeUtils.importESModule("resource://gre/modules/AppUpdater.sys.mjs");
            const { Updates } = ChromeUtils.importESModule("resource:///modules/enterprise/Updates.sys.mjs");
            Updates.appUpdaterCallback(AppUpdater.STATUS[arguments[0]]);
            """,
            [error],
        )
        self._driver.set_context("content")

    def trigger_updateError_error(self, error):
        self._driver.set_context("chrome")
        self._driver.execute_script(
            """
            Services.obs.notifyObservers(null, "update-error", arguments[0]);
            """,
            [error],
        )
        self._driver.set_context("content")

    def get_error(self, error_name, trigger=None, kind="error"):
        assert trigger in ["appUpdater", "update-error"], (
            f"Update error trigger should be either appUpdater/update-error, got {trigger}"
        )

        self.reload_chrome_window()

        if trigger == "appUpdater":
            self._logger.info(f"Simulating AppUpdater error: {error_name}")
            self.trigger_appUpdater_error(error_name)
        elif trigger == "update-error":
            self._logger.info(f"Simulating nsIUpdateService update-error: {error_name}")
            self.trigger_updateError_error(error_name)

        self._driver.set_context("chrome")

        browser_error = self.get_elem(".felt-browser-error")
        assert browser_error, "Error dialog present"

        title = self.get_elem(f".felt-updates-{kind}-messages")
        title_id = title.get_attribute("data-l10n-id")

        error_details = self.get_elem(
            f".felt-updates-{kind}-messages .felt-browser-error-details"
        )
        error_msg = error_details.text

        self.maybe_save_screenshot(Environment.FELT, error_name)

        self._driver.set_context("content")

        return (title_id, error_msg)

    def test_felt_updates_error_handling(self):
        # We are not going to start the browser so do not try to close it
        self._manually_closed_child = True
        # Make sure the iteration and callable() check below will not choke on
        # this missing attribute
        self._child_driver = None

        object_methods = [
            method_name
            for method_name in dir(self)
            if callable(getattr(self, method_name))
            and method_name.startswith("run_error")
        ]
        for m in object_methods:
            getattr(self, m)()

    def assert_error(self, name, trigger, title, error, kind):
        (title_id, err) = self.get_error(name, trigger, kind)
        assert title_id == title, (
            f"Error title '{title_id}' is correct, expected '{title}'"
        )
        assert err == error, f"Error details '{err}' is correct, expected '{error}'"

    def run_error_manual_update(self):
        self.assert_error(
            "MANUAL_UPDATE",
            "appUpdater",
            "felt-error-updates",
            "Please contact your administrator.",
            "error",
        )

    def run_error_internal_error(self):
        self.assert_error(
            "INTERNAL_ERROR",
            "appUpdater",
            "felt-error-updates",
            "Please contact your administrator.",
            "error",
        )

    def run_error_unsupported_system(self):
        self.assert_error(
            "UNSUPPORTED_SYSTEM",
            "appUpdater",
            "felt-warning-unsupported-system-contact-admin",
            "A new version of Firefox Enterprise is available, but your operating system is not supported. Contact your administrator for assistance.",
            "warning",
        )

    def run_error_checking_failed(self):
        self.assert_error(
            "CHECKING_FAILED",
            "appUpdater",
            "felt-error-updates",
            "Unexpected failure while checking for an update. Please contact your administrator.",
            "error",
        )

    def run_error_elevation_attempt_failed(self):
        self.assert_error(
            "elevation-attempt-failed",
            "update-error",
            "felt-warning-title-elevation-attempt-failed",
            "An update couldn’t be installed due to insufficient system privileges. Please contact your administrator for help.",
            "warning",
        )

    def run_error_download_attempt_failed(self):
        self.assert_error(
            "download-attempt-failed",
            "update-error",
            "felt-warning-title-download-attempt-failed",
            "The latest update couldn’t be downloaded. If this problem persists, contact your administrator for help.",
            "warning",
        )
