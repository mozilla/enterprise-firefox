#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class CustomEnterpriseUITests(FeltTests):

    def test_enterprise_browser_ui(self):
        super().run_felt_base()
        self.connect_child_browser()
        self.assert_enterprise_badge_and_panel()

    def assert_enterprise_badge_and_panel(self):
        whoami = self.get_whoami()

        self._child_driver.set_context("chrome")

        assert whoami["id"], "Expected user to exist"
        assert whoami["email"], "Expected user email to exist"
        assert whoami["picture"], "Expected user picture to exist"

        self._logger.info("Checking for enterprise badge.")
        badge = self.get_elem_child("#enterprise-badge-toolbar-button")

        self._logger.info("Checking user icon is updated in badge.")
        user_icon = self.get_elem_child("#enterprise-user-icon")
        picture_url = user_icon.value_of_css_property("list-style-image")
        assert picture_url == f'url("{whoami["picture"]}")', (
            "User's picture not correctly set on user icon"
        )
        
        self._logger.info("Clicking enterprise panel")
        badge.click()

        self._logger.info("Checking enterprise panel")
        self.get_elem_child("#panelUI-enterprise")

        self._logger.info("Checking user email address updated in enterprise panel")
        email = self.get_elem_child(".panelUI-enterprise__email")
        assert email.get_property("textContent") == whoami["email"], (
            "User email not correctly set"
        )

        self._child_driver.set_context("content")