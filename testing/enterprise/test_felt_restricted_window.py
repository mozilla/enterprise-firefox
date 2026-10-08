#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import sys
import time
import unittest

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests
from marionette_driver.keys import Keys

ESCAPE_KEYS = [
    "key_newNavigatorTab",
    "key_newNavigator",
    "key_privatebrowsing",
    "openFileKb",
    "focusURLBar",
    "goHome",
    "key_viewSource",
    "key_openDownloads",
    "key_openAddons",
    "key_sanitize",
    "printKb",
]

ESCAPE_APP_MENU_ITEMS = [
    "aboutName",
    "menu_settings",
    "menu_preferences",
]


class FeltRestrictedWindow(FeltTests):
    """
    Test that a browser window opened by window.open() from the pre-auth FELT
    SSO browser cannot be used to reach other content. The FELT UI process
    runs no enterprise policies, so the shortcuts that open other content and
    link drops must not work in it.
    """

    def teardown(self):
        # These tests never complete authentication, so there is no child
        # browser to tear down.
        self._manually_closed_child = True
        super().teardown()

    def _url(self, path):
        return f"http://localhost:{self.sso_port}{path}"

    def _accel(self):
        if self._driver.session_capabilities["platformName"] == "mac":
            return Keys.META
        return Keys.CONTROL

    def _window_state(self):
        self._driver.set_context("chrome")
        return self._driver.execute_script(
            """
            if (!window.gBrowser) {
              return { tabs: 0, url: null };
            }
            return {
              tabs: gBrowser.tabs.length,
              url: gBrowser.currentURI.spec,
            };
            """
        )

    def _open_restricted_window(self):
        self.run_felt_chrome_on_email_submit()
        self.run_wait_until_sso_loaded()
        self._driver.set_context("chrome")
        felt_handle = self._driver.current_chrome_window_handle
        self._driver.set_context("content")
        self._driver.execute_script(
            "window.open(arguments[0], '_blank');",
            script_args=[self._url("/watermark_blank_page")],
        )

        self._driver.set_context("chrome")
        self._wait.until(
            lambda _: len(self._driver.chrome_window_handles) == 2,
            message="window.open() from the SSO browser opens a browser window",
        )
        restricted_handle = next(
            h for h in self._driver.chrome_window_handles if h != felt_handle
        )
        self._driver.switch_to_window(restricted_handle)
        self._wait_for_single_tab_at("/watermark_blank_page")

    def _wait_for_single_tab_at(self, path):
        self._wait.until(
            lambda _: self._window_state()["url"] == self._url(path),
            message=f"The browser window shows {path}",
        )
        assert self._window_state()["tabs"] == 1, "The browser window has one tab"
        assert len(self._driver.chrome_window_handles) == 2, (
            "No other browser window is opened"
        )

    def test_escape_keys_are_disabled(self):
        self._open_restricted_window()

        enabled_keys = self._driver.execute_script(
            """
            return Array.from(document.getElementsByTagName("key"))
              .filter(key => key.getAttribute("disabled") != "true")
              .map(key => key.id);
            """
        )
        for key_id in ESCAPE_KEYS:
            assert key_id not in enabled_keys, f"{key_id} is disabled"

        for key in ["t", "n"]:
            self._driver.actions.sequence("key", "keyboard").key_down(
                self._accel()
            ).key_down(key).key_up(key).key_up(self._accel()).perform()
        time.sleep(1)
        self._wait_for_single_tab_at("/watermark_blank_page")
        self._driver.set_context("content")

    def test_link_drops_are_ignored(self):
        self._open_restricted_window()
        assert self._driver.execute_script(
            "return gBrowser.selectedBrowser.droppedLinkHandler === null;"
        ), "The browser has no dropped link handler"
        self._driver.set_context("content")

    def test_toolbars_are_hidden(self):
        self._open_restricted_window()

        visible_toolbars = self._driver.execute_script(
            """
            return Array.from(
              document.querySelectorAll("#navigator-toolbox > toolbar")
            )
              .filter(toolbar => toolbar.getBoundingClientRect().height > 0)
              .map(toolbar => toolbar.id);
            """
        )
        assert visible_toolbars == [], f"{visible_toolbars} are hidden"
        assert not self._driver.execute_script(
            "return document.documentElement.hasAttribute('customtitlebar');"
        ), "The browser window uses the native titlebar"
        self._driver.set_context("content")

    @unittest.skipUnless(sys.platform == "darwin", "macOS application menu")
    def test_app_menu_has_no_escape_items(self):
        self._open_restricted_window()

        collapsed = self._driver.execute_script(
            """
            const doc = Services.appShell.hiddenDOMWindow.document;
            return arguments[0].filter(
              id => doc.getElementById(id)?.getAttribute("collapsed") == "true"
            );
            """,
            script_args=[ESCAPE_APP_MENU_ITEMS],
        )
        for item_id in ESCAPE_APP_MENU_ITEMS:
            assert item_id in collapsed, f"{item_id} is not in the application menu"
        self._driver.set_context("content")
