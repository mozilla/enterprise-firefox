#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests


class EnterpriseBadgeTests(FeltTests):
    def test_enterprise_browser_ui(self):
        super().run_felt_base()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)
        self.assert_enterprise_badge_and_panel()

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

        self._logger.info("Checking enterprise panel")
        self.get_elem_child("#panelUI-enterprise")

        self._logger.info("Checking user email address updated in enterprise panel")
        email = self.get_elem_child(".panelUI-enterprise__email")
        assert email.get_property("textContent") == user["email"], (
            "User email not correctly set"
        )

        self._child_driver.set_context("content")
