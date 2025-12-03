#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import json
import sys

from felt_tests import FeltTests


class BrowserSync(FeltTests):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def test_felt_2_browser_sync_app_menu_hidden(self, exp):
        self.connect_child_browser()

        self._child_driver.set_context("chrome")
        [app_menu_status, app_menu_separator] = self._child_driver.execute_script(
            """
            const { PanelMultiView } = ChromeUtils.importESModule("moz-src:///browser/components/customizableui/PanelMultiView.sys.mjs");
            const appMenuStatus = PanelMultiView.getViewNode(document, "appMenu-fxa-status2");
            const appMenuSeparator = PanelMultiView.getViewNode(document, "appMenu-fxa-separator");
            return [ appMenuStatus.style.getPropertyValue("visibility"), appMenuSeparator.style.getPropertyValue("visibility") ];
            """,
        )
        self._child_driver.set_context("content")
        assert (
            app_menu_status == "collapse" and app_menu_separator == "collapse"
        ), "Sync app menu should be not visible"

        return True

    def test_felt_3_fxaccount_prefs_values(self, exp):
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
        assert (
            fxaccounts_remote_oauth == f"{console_addr}/api/fxa/api/v1"
        ), f"FxAccount remote auth URI correct: {fxaccounts_remote_oauth}"
        assert (
            fxaccounts_remote_profile == f"{console_addr}/api/fxa/profile/v1"
        ), f"FxAccount remote profile URI correct: {fxaccounts_remote_profile}"
        assert (
            fxaccounts_auth == f"{console_addr}/api/fxa/api/v1"
        ), f"FxAccount auth URI correct: {fxaccounts_auth}"
        assert (
            sync_token_server
            == "https://ent-dev-tokenserver.sync.nonprod.webservices.mozgcp.net/1.0/sync/1.5"
        ), f"Sync TokenServer URI correct: {sync_token_server}"

        return True

    def test_felt_4_browser_sync_preferences_has_sync(self, exp):
        self.open_tab_child("about:preferences#sync")

        # TODO: Can we get the mock server not to reject?
        login_rejected = self.get_elem_child("#fxaLoginRejected")
        assert login_rejected.is_displayed(), "Login was rejected but is shown"

        l10n_data = json.loads(
            self.find_elem_child(".l10nArgsEmailAddress").get_attribute(
                "data-l10n-args"
            )
        )
        assert l10n_data["email"] == "nobody@mozilla.org", "There is an email for Sync"

        return True

    def test_felt_5_browser_sync_preferences_choose(self, exp):
        sync_change = self.find_elem_child("#syncChangeOptions")
        sync_change.click()

        dialog_frame = self.find_elem_child(".dialogFrame")
        self._child_driver.switch_to.frame(dialog_frame)

        sync_choose = self.find_elem_child("#syncChooseOptions")
        assert sync_choose.is_displayed(), "Sync choose options dialog displayed"

        disconnect_button = self._child_driver.execute_script(
            """
             return arguments[0].shadowRoot.querySelector("button[dlgtype='extra2']");
             """,
            sync_choose,
        )
        assert (
            not disconnect_button.is_displayed()
        ), "Disconnect button is not displayed"

        return True


if __name__ == "__main__":
    BrowserSync(
        "felt_browser_sync.json",
        firefox=sys.argv[1],
        geckodriver=sys.argv[2],
        profile_root=sys.argv[3],
        env_vars={"MOZ_FELT_UI": "1"},
        test_prefs=[
            ["browser.enterprise.loglevel", "debug"],
        ],
    )
