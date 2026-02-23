#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests
from marionette_driver.keys import Keys


class EnterpriseBadgeTests(FeltTests):
    def test_enterprise_browser_ui(self):
        super().run_felt_base()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)
        self.assert_enterprise_badge_and_panel()
        self.assert_enterprise_panel_accessible_by_keypress()

    def assert_enterprise_badge_and_panel(self):
        user = self.get_logged_in_user_info(env=Environment.FIREFOX)

        self._child_driver.set_context("chrome")

        self._logger.info("Checking for enterprise badge.")
        badge = self.get_elem_child("#enterprise-badge-toolbar-button")

        self._logger.info("Checking user icon is updated in badge.")
        user_icon = self.get_elem_child("#enterprise-user-icon")
        picture_url = user_icon.value_of_css_property("list-style-image")
        assert picture_url == f'url("{user["picture"]}")', (
            "User's picture not correctly set on user icon"
        )

        self._logger.info("Clicking enterprise panel")
        badge.click()

        self._logger.info("Checking enterprise panel is displayed")
        self.get_elem_child("#panelUI-enterprise")

        self._logger.info("Checking user email address updated in enterprise panel")
        email = self.get_elem_child(".panelUI-enterprise__email")
        assert email.get_property("textContent") == user["email"], (
            "User email not correctly set"
        )

        self._logger.info("Closing enterprise panel")
        chrome_body = self.get_elem_child("body")
        chrome_body.send_keys(Keys.ESCAPE)

        self._child_driver.set_context("content")

    def assert_enterprise_panel_accessible_by_keypress(self):
        self._child_driver.set_context("chrome")

        # Move focus into chrome
        chrome_body = self.get_elem_child("body")
        chrome_body.send_keys(Keys.F6)

        # Note: Sending keys on chrome body because the toolbar button
        # is not reachable by keyboard (ElementNotInteractableException)
        badge = self.get_elem_child("#enterprise-badge-toolbar-button")

        def tab_and_get_next_active_element_id():
            self._logger.info("Triggering Keys.TAB")
            chrome_body.send_keys(Keys.TAB)
            return self._child_driver.execute_script(
                """
                return document.activeElement;
            """,
                [],
            )

        self._logger.info("Tabbing through chrome elements until badge focused")
        # This can cause an inifinite tab loop if the badge becomes unreachable
        # in case of further changes to the toolbar. Worst case it results in a
        # timeout and test failure.
        self._wait.until(lambda _: tab_and_get_next_active_element_id() == badge)

        is_focus_visible_on_badge = self._child_driver.execute_script(
            """
                return arguments[0].matches(":focus-visible");
                """,
            [badge],
        )
        assert is_focus_visible_on_badge, "Badge is not :focus-visible"

        self._logger.info("Opening enterprise panel by keypress.")
        chrome_body.send_keys(Keys.ENTER)

        self._logger.info("Checking enterprise panel is displayed")
        self.get_elem_child("#panelUI-enterprise")

        self._child_driver.set_context("content")
