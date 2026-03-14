#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests
from marionette_driver.errors import (
    InvalidSessionIdException,
    JavascriptException,
    NoSuchWindowException,
    UnknownException,
)


class BrowserOsSession(FeltTests):
    def felt_whoami(self):
        self._child_driver.set_context("chrome")
        rv = self._child_driver.execute_script(
            """
            const { ConsoleClient } = ChromeUtils.importESModule("resource:///modules/enterprise/ConsoleClient.sys.mjs");
            return ConsoleClient._get(ConsoleClient._paths.WHOAMI);
            """,
        )
        self._child_driver.set_context("content")
        return rv

    def fire_os_event_and_expect_quit(self, topic):
        """Fire an OS event observer topic on the child browser and expect
        it to quit. Sets _manually_closed_child before firing to avoid
        teardown errors."""
        self._manually_closed_child = True
        self._child_driver.set_context("chrome")
        try:
            self._child_driver.execute_script(
                f'Services.obs.notifyObservers(null, "{topic}", null);'
            )
        except (
            JavascriptException,
            NoSuchWindowException,
            InvalidSessionIdException,
            UnknownException,
            OSError,
        ):
            pass

    def test_os_session_end_triggers_signout(self):
        """Simulate os-session-end: verify tokens cleared, browser quits,
        FELT shows login with pre-filled email."""
        super().run_felt_base()
        self.connect_child_browser()

        whoami = self.felt_whoami()
        assert whoami["email"], "User should be signed in"
        signed_in_email = whoami["email"]

        self.fire_os_event_and_expect_quit("os-session-end")

        self.await_felt_auth_window()
        self.force_window()
        self._driver.set_context("chrome")
        email = self.get_elem("#felt-form__email").get_property("value")
        assert email == signed_in_email, (
            "Email should be pre-filled after OS-initiated signout"
        )
        self._driver.set_context("content")

    def test_os_user_switch_triggers_signout_when_enabled(self):
        """Simulate os-user-switch with pref enabled (default):
        verify signout flow runs."""
        super().run_felt_base()
        self.connect_child_browser()
        whoami = self.felt_whoami()
        signed_in_email = whoami["email"]

        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            """
            Services.prefs.setBoolPref("enterprise.signoutOnUserSwitch", true);
            """
        )
        self._child_driver.set_context("content")

        self.fire_os_event_and_expect_quit("os-user-switch")

        self.await_felt_auth_window()
        self.force_window()
        self._driver.set_context("chrome")
        email = self.get_elem("#felt-form__email").get_property("value")
        assert email == signed_in_email, (
            "Email should be pre-filled after user-switch signout"
        )
        self._driver.set_context("content")

    def test_os_user_switch_ignored_when_disabled(self):
        """Simulate os-user-switch with pref disabled:
        verify browser stays signed in."""
        super().run_felt_base()
        self.connect_child_browser()

        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            """
            Services.prefs.setBoolPref("enterprise.signoutOnUserSwitch", false);
            """
        )

        self._child_driver.execute_script(
            """
            Services.obs.notifyObservers(null, "os-user-switch", null);
            """
        )
        self._child_driver.set_context("content")

        whoami = self.felt_whoami()
        assert whoami["email"], "User should still be signed in"

    def test_screen_lock_triggers_signout_when_enabled(self):
        """Simulate screen-locked with pref enabled:
        verify signout flow runs."""
        super().run_felt_base()
        self.connect_child_browser()
        whoami = self.felt_whoami()
        signed_in_email = whoami["email"]

        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            """
            Services.prefs.setBoolPref("enterprise.signoutOnScreenLock", true);
            """
        )
        self._child_driver.set_context("content")

        self.fire_os_event_and_expect_quit("screen-locked")

        self.await_felt_auth_window()
        self.force_window()
        self._driver.set_context("chrome")
        email = self.get_elem("#felt-form__email").get_property("value")
        assert email == signed_in_email, (
            "Email should be pre-filled after screen-lock signout"
        )
        self._driver.set_context("content")

    def test_screen_lock_ignored_when_disabled(self):
        """Simulate screen-locked with pref disabled (default):
        verify browser stays signed in."""
        super().run_felt_base()
        self.connect_child_browser()

        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            """
            Services.prefs.setBoolPref("enterprise.signoutOnScreenLock", false);
            """
        )

        self._child_driver.execute_script(
            """
            Services.obs.notifyObservers(null, "screen-locked", null);
            """
        )
        self._child_driver.set_context("content")

        whoami = self.felt_whoami()
        assert whoami["email"], "User should still be signed in"
