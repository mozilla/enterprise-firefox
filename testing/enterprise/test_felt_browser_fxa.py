#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class BrowserFxAccount(FeltTests):
    EXTRA_PREFS = {
        "enterprise.loglevel": "Debug",
    }

    def test_browser_fxa(self):
        super().run_felt_base()
        self.run_felt_no_fxa_toolbar_button()
        self.run_felt_no_fxa_item_in_toolbar_menu()
        self.run_felt_fxa_endpoints_set()

    def run_felt_no_fxa_toolbar_button(self):
        self.connect_child_browser()

        self._child_driver.set_context("chrome")
        [
            fxaccounts_toolbar_enabled,
        ] = self._child_driver.execute_script(
            """
            return [
                Services.prefs.getBoolPref("identity.fxaccounts.toolbar.enabled"),
            ];
            """,
        )

        assert not fxaccounts_toolbar_enabled, (
            "FxAccount toolbar button shouldn't be visible in the toolbar"
        )

    def run_felt_no_fxa_item_in_toolbar_menu(self):
        self._child_driver.set_context("chrome")

        self._logger.info("Getting menu button")
        menu_button = self.get_elem_child("#PanelUI-menu-button")
        self._logger.info("Clicking menu button to open panel")
        menu_button.click()
        app_menu_main_view = self.get_elem_child("#appMenu-mainView")
        is_restricted_for_enterprise = app_menu_main_view.get_attribute(
            "restricted-enterprise-view"
        )

        self._child_driver.set_context("content")
        assert is_restricted_for_enterprise, (
            "App menu main view should have the attribute restricted-enterprise-view to hide fxa status and separator"
        )

    def run_felt_fxa_endpoints_set(self):
        self._child_driver.set_context("chrome")
        [
            fxaccounts_remote_oauth,
            fxaccounts_remote_profile,
            fxaccounts_auth,
            sync_token_server,
        ] = self._child_driver.execute_script(
            """
            return [
                Services.prefs.getStringPref("identity.fxaccounts.remote.oauth.uri"),
                Services.prefs.getStringPref("identity.fxaccounts.remote.profile.uri"),
                Services.prefs.getStringPref("identity.fxaccounts.auth.uri"),
                Services.prefs.getStringPref("identity.sync.tokenserver.uri"),
            ];
            """,
        )
        self._child_driver.set_context("content")

        console_addr = f"http://localhost:{self.console_port}"
        assert fxaccounts_remote_oauth == f"{console_addr}/api/fxa/oauth/v1", (
            f"FxAccount remote auth URI correct: {fxaccounts_remote_oauth}"
        )
        assert fxaccounts_remote_profile == f"{console_addr}/api/fxa/profile/v1", (
            f"FxAccount remote profile URI correct: {fxaccounts_remote_profile}"
        )
        assert fxaccounts_auth == f"{console_addr}/api/fxa/api/v1", (
            f"FxAccount auth URI correct: {fxaccounts_auth}"
        )
        assert (
            sync_token_server
            == "https://ent-dev-tokenserver.sync.nonprod.webservices.mozgcp.net/1.0/sync/1.5"
        ), f"Sync TokenServer URI correct: {sync_token_server}"

    # More tests to follow once fxa and sync test endpoints are setup
