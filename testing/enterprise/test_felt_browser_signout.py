#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys
import uuid

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests
from marionette_driver.errors import (
    JavascriptException,
    NoSuchWindowException,
    UnexpectedAlertOpen,
    UnknownException,
)


class BaseBrowserSignout(FeltTests):
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

    def force_window(self):
        self._driver.set_context("chrome")
        assert len(self._driver.chrome_window_handles) == 1, "One window exists"
        self._driver.switch_to_window(self._driver.chrome_window_handles[0])
        self._driver.set_context("content")

    def get_private_cookies(self):
        self._driver.set_context("chrome")
        private_cookies = self._driver.execute_script(
            """
            const { FeltCommon } = ChromeUtils.importESModule("chrome://felt/content/FeltCommon.sys.mjs");
            console.debug(`Checking private cookies for browsing ID: ${FeltCommon.PRIVATE_BROWSING_ID}`);
            return Services.cookies.getCookiesWithOriginAttributes(
              JSON.stringify({
                privateBrowsingId: FeltCommon.PRIVATE_BROWSING_ID,
              })
            );
            """,
        )
        self._driver.set_context("content")
        return private_cookies

    def run_browser_ui_state_when_user_is_logged_in(self):
        self.connect_child_browser(
            capabilities={
                # Do not auto-handle prompts.
                "unhandledPromptBehavior": "ignore"
            }
        )

        whoami = self.felt_whoami()
        assert whoami["id"], "Expected user to exist"
        assert whoami["email"], "Expected user email to exist"
        assert whoami["picture"], "Expected user picture to exist"

        # Save email for later to test that email is correctly pre-filled
        # in test_felt_7_prefilled_email_submit
        self._signed_in_email = whoami["email"]

        self._child_driver.set_context("chrome")

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

    def run_perform_signout(self):
        self.open_tab_child("about:newtab")

        self._child_driver.set_context("chrome")

        self._logger.info("Clicking enterprise badge to open enterprise panel")
        self.get_elem_child("#enterprise-badge-toolbar-button").click()

        # Making sure we get to handle the Signout dialog
        assert (
            self._child_driver.session_capabilities.get("unhandledPromptBehavior")
            == "ignore"
        ), "Driver should not auto-handle prompt"

        try:
            # This will cause an UnexpectedAlertPresentException, which is our expected signout dialog
            self._logger.info("Clicking signout button in enterprise panel")
            self.get_elem_child(".panelUI-enterprise__sign-out-btn").click()
        except UnexpectedAlertOpen:
            # Do nothing, signout dialog ("alert") is expected
            pass

        self._logger.info("Waiting for the signout dialog to open")
        alert = self._child_driver.switch_to_alert()
        # Wait(self._child_driver, 5).until(alert)

        self._logger.info(
            "Signing out the user by clicking the Signout button in the dialog"
        )
        # This target the primary action, which is clicking the Signout button
        alert.accept()

        self._child_driver.set_context("content")

        # This is not true but it will make sure the harness does not try to
        # cleanup the browser and we can then make sure that our self-closing
        # is correct.
        self._manually_closed_child = True

        # Set new cookie on server side
        self.cookie_name.value = str(uuid.uuid1()).split("-")[0]
        self.cookie_value.value = str(uuid.uuid4()).split("-")[4]

    def run_whoami(self):
        try:
            self.felt_whoami()
            assert False, "Error on signout"
        except JavascriptException as ex:
            assert ex.msg == "InvalidAuthError: Unhandled reauthentication", (
                "Deauth done"
            )
        except NoSuchWindowException:
            pass
        except UnknownException as ex:
            assert ex.msg == "Failed to decode response from marionette", "Deauth done"
        except OSError:
            pass

    def run_prefilled_email_submit(self):
        self.await_felt_auth_window()
        self.force_window()

        cookies = self.get_private_cookies()
        assert len(cookies) == 0, f"No private cookies, found {len(cookies)}"

        self._driver.set_context("chrome")
        email = self.get_elem("#felt-form__email").get_property("value")
        assert email == self._signed_in_email, (
            "Expected email to be pre-filled after signout"
        )
        self._driver.set_context("content")

        self.run_felt_chrome_on_email_submit()

    def run_load_sso(self):
        self.force_window()
        self.run_felt_load_sso()

    def run_perform_sso_auth(self):
        self.force_window()
        self.run_felt_perform_sso_auth()
        # We will be restarting again
        self._manually_closed_child = False

    def run_new_browser(self):
        self.connect_child_browser()

    def run_new_browser_new_tab(self):
        self.open_tab_child(f"http://localhost:{self.sso_port}/sso_page")

        expected_cookie = list(
            filter(
                lambda x: x["name"] == self.cookie_name.value
                and x["value"] == self.cookie_value.value,
                self._child_driver.get_cookies(),
            )
        )

        assert len(expected_cookie) == 1, (
            f"Cookie {self.cookie_name} was properly set on Firefox started by FELT, found {expected_cookie}"
        )


class BrowserSignout(BaseBrowserSignout):
    def test_browser_signout(self):
        super().run_felt_base()
        self.run_browser_ui_state_when_user_is_logged_in()
        self.run_perform_signout()
        self.run_whoami()
        self.run_prefilled_email_submit()
        self.run_load_sso()
        self.run_perform_sso_auth()
        self.run_new_browser()
        self.run_new_browser_new_tab()
