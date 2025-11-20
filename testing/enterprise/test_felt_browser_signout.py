#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import sys
import uuid

from felt_tests import FeltTests
from selenium.common.exceptions import (
    JavascriptException,
    NoSuchWindowException,
    WebDriverException,
)
from selenium.webdriver.support import expected_conditions as EC


class BrowserSignout(FeltTests):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

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

    def wait_sso_window(self):
        tabs = self._driver.window_handles
        self._wait.until(EC.new_window_is_opened(tabs))

    def force_window(self):
        self._driver.set_context("chrome")
        assert len(self._driver.window_handles) == 1, "One window exists"
        self._driver.switch_to.window(self._driver.window_handles[0])
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

    def test_felt_3_browser_ui_state_when_user_is_logged_in(self, exp):
        self.connect_child_browser()

        whoami = self.felt_whoami()
        assert whoami["id"], "Expected user to exist"
        assert whoami["email"], "Expected user email to exist"
        assert whoami["picture"], "Expected user picture to exist"

        self._child_driver.set_context("chrome")

        self._logger.info("Checking for enterprise badge.")
        badge = self.get_elem_child("#enterprise-badge-toolbar-button")

        self._logger.info("Checking user icon is updated in badge.")
        user_icon = self.get_elem_child("#enterprise-user-icon")
        picture_url = user_icon.value_of_css_property("list-style-image")
        assert (
            picture_url == f"url(\"{whoami['picture']}\")"
        ), "User's picture not correctly set on user icon"

        self._logger.info("Clicking enterprise panel")
        badge.click()

        self._logger.info("Checking enterprise panel")
        self.get_elem_child("#panelUI-enterprise")

        self._logger.info("Checking user email address updated in enterprise panel")
        email = self.get_elem_child(".panelUI-enterprise__email")

        self._logger.info(email)
        assert (
            email.get_property("textContent") == whoami["email"]
        ), "User email not correctly set"

        self._child_driver.set_context("content")

        return True

    def test_felt_4_perform_signout(self, exp):
        self.open_tab_child("about:newtab")

        self._child_driver.set_context("chrome")
        self.get_elem_child("#enterprise-badge-toolbar-button").click()
        self.get_elem_child(".panelUI-enterprise__sign-out-btn").click()
        self._child_driver.set_context("content")

        # This is not true but it will make sure the harness does not try to
        # cleanup the browser and we can then make sure that our self-closing
        # is correct.
        self._manually_closed_child = True

        # Set new cookie on server side
        self.cookie_name.value = str(uuid.uuid1()).split("-")[0]
        self.cookie_value.value = str(uuid.uuid4()).split("-")[4]

        return True

    def test_felt_5_whoami(self, exp):
        try:
            self.felt_whoami()
            assert False, "Error on signout"
        except JavascriptException as ex:
            assert (
                ex.msg == "InvalidAuthError: Unhandled reauthentication"
            ), "Deauth done"
            return True
        except NoSuchWindowException:
            return True
        except WebDriverException as ex:
            assert ex.msg == "Failed to decode response from marionette", "Deauth done"
            return True

        return True

    def test_felt_7_email_submit(self, exp):
        self.wait_sso_window()
        self.force_window()

        cookies = self.get_private_cookies()
        assert len(cookies) == 0, f"No private cookies, found {len(cookies)}"

        self.test_felt_00_chrome_on_email_submit(exp)
        return True

    def test_felt_8_load_sso(self, exp):
        self.force_window()
        self.test_felt_0_load_sso(exp)
        return True

    def test_felt_9_0_perform_sso_auth(self, exp):
        self.force_window()
        self.test_felt_1_perform_sso_auth(exp)
        # We will be restarting again
        self._manually_closed_child = False
        return True

    def test_felt_9_1_new_browser(self, exp):
        self.connect_child_browser()
        return True

    def test_felt_9_2_new_browser_new_tab(self, exp):
        self.open_tab_child(f"http://localhost:{self.sso_port}/sso_page")

        expected_cookie = list(
            filter(
                lambda x: x["name"] == self.cookie_name.value
                and x["value"] == self.cookie_value.value,
                self._child_driver.get_cookies(),
            )
        )

        assert (
            len(expected_cookie) == 1
        ), f"Cookie {self.cookie_name} was properly set on Firefox started by FELT, found {expected_cookie}"

        return True


if __name__ == "__main__":
    BrowserSignout(
        "felt_browser_signout.json",
        firefox=sys.argv[1],
        geckodriver=sys.argv[2],
        profile_root=sys.argv[3],
        env_vars={"MOZ_FELT_UI": "1"},
    )
