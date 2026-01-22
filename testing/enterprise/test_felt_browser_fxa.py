#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import sys

from felt_tests import FeltTests


class BrowserFxAccount(FeltTests):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def test_felt_2_no_fxa_toolbar_button(self, exp):

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

        return True

    def test_felt_3_no_fxa_item_in_toolbar_menu(self, exp):

        self._child_driver.set_context("chrome")

        self._logger.info("Getting menu button")
        menu_button = self.get_elem_child("#PanelUI-menu-button")
        self._logger.info("Clicking menu button to open panel")
        menu_button.click()
        app_menu_main_view = self.get_elem_child("#appMenu-mainView")
        self._logger.info(app_menu_main_view)
        is_restricted_for_enterprise = app_menu_main_view.get_attribute(
            "restricted-enterprise-view"
        )

        self._child_driver.set_context("content")
        assert is_restricted_for_enterprise, (
            "App menu main view should have the attribute restricted-enterprise-view to hide fxa status and separator"
        )

        return True

    def test_felt_4_fxa_endpoints_set(self, exp):
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

        return True

    # More tests to follow once fxa and sync test endpoints are setup


if __name__ == "__main__":
    BrowserFxAccount(
        "felt_browser_fxa.json",
        firefox=sys.argv[1],
        geckodriver=sys.argv[2],
        profile_root=sys.argv[3],
        env_vars={"MOZ_FELT_UI": "1"},
        test_prefs=[
            ["enterprise.loglevel", "Debug"],
            ["enterprise.sync.enabledByDefault", False],
        ],
    )
