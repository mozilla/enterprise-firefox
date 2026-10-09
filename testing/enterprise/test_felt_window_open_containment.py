#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests

WINDOW_OPEN_PANE = ".felt-login__window-open"
SSO_PANE = ".felt-login__sso"
EMAIL_PANE = ".felt-login__email-pane"


class FeltWindowOpenContainment(FeltTests):
    """
    Test that window.open() from the pre-auth FELT SSO browser cannot produce
    a browser window in the FELT UI process, which runs no enterprise
    policies. The requested URL is shown in the window.open pane instead.

    Both forms are covered because they reach the open along different paths:
    a plain open consults nsIBrowserDOMWindow, while one carrying window
    features resolves to OPEN_NEWWINDOW up front unless
    browser.link.open_newwindow.restriction is 0.

    The opens are driven by clicking a button so they carry user activation,
    which keeps the popup blocker from dropping them before they reach
    nsIBrowserDOMWindow.
    """

    def teardown(self):
        # These tests never complete authentication, so there is no child
        # browser to tear down.
        self._manually_closed_child = True
        super().teardown()

    def _url(self, path):
        return f"http://localhost:{self.sso_port}{path}"

    def _goto_opener_page(self):
        self.run_felt_chrome_on_email_submit()
        self.run_wait_until_sso_loaded()
        self._driver.set_context("content")
        self._driver.navigate(self._url("/popup_opener"))
        self._wait.until(
            lambda mn: mn.get_url().endswith("/popup_opener"),
            message="The opener page loads in the SSO browser",
        )

    def _pane_state(self):
        self._driver.set_context("chrome")
        return self._driver.execute_script(
            """
            const pane = document.querySelector(arguments[0]);
            const browser = document.getElementById("window-open-browser");
            return {
              shown: !pane.classList.contains("is-hidden"),
              url: browser && browser.currentURI ? browser.currentURI.spec : null,
            };
            """,
            [WINDOW_OPEN_PANE],
        )

    def _assert_contained_in_pane(self, path="/watermark_blank_page"):
        self._wait.until(
            lambda _: self._pane_state()["url"] == self._url(path),
            message="The requested URL is shown in the window.open pane",
        )
        state = self._pane_state()
        assert state["shown"], "The window.open pane is visible"
        assert len(self._driver.chrome_window_handles) == 1, (
            "No browser window is opened in the FELT UI process"
        )

    def _window_open_cookie_names(self):
        self._driver.set_context("chrome")
        return self._driver.execute_script(
            """
            const { FeltCommon } = ChromeUtils.importESModule(
              "chrome://felt/content/FeltCommon.sys.mjs"
            );
            const { userContextId } =
              document.getElementById("window-open-browser").browsingContext.originAttributes;
            if (!userContextId) {
              return null;
            }
            return Services.cookies
              .getCookiesWithOriginAttributes(
                JSON.stringify({
                  privateBrowsingId: FeltCommon.PRIVATE_BROWSING_ID,
                  userContextId,
                })
              )
              .map(c => c.name);
            """
        )

    def _forwarded_cookie_names(self):
        self._driver.set_context("chrome")
        return self._driver.execute_script(
            """
            const { FeltProcessParent } = ChromeUtils.importESModule(
              "chrome://felt/content/FeltProcessParent.sys.mjs"
            );
            return FeltProcessParent.prototype.getAllCookies().map(c => c.name);
            """
        )

    def test_plain_window_open_is_contained(self):
        self._goto_opener_page()
        self.get_elem("#open-plain").click()
        self._assert_contained_in_pane()
        self._driver.set_context("content")

    def test_featured_window_open_is_contained(self):
        self._goto_opener_page()
        self.get_elem("#open-features").click()
        self._assert_contained_in_pane()
        self._driver.set_context("content")

    def test_back_button_closes_window_open_pane_first(self):
        self._goto_opener_page()
        self.get_elem("#open-plain").click()
        self._assert_contained_in_pane()

        self._driver.set_context("chrome")
        self.get_elem("#felt-back-button").click()
        self._wait.until(
            lambda _: not self._pane_state()["shown"],
            message="Back hides the window.open pane",
        )
        self._driver.set_context("chrome")
        assert self.find_elem(SSO_PANE).is_displayed(), (
            "The SSO attempt is still shown after closing the window.open pane"
        )

        self.get_elem("#felt-back-button").click()
        self._wait.until(
            lambda _: self.find_elem(EMAIL_PANE).is_displayed(),
            message="A second Back returns to the email pane",
        )
        self._driver.set_context("content")

    def test_window_open_cookies_are_not_forwarded(self):
        self._goto_opener_page()
        self.get_elem("#open-cookie").click()
        self._assert_contained_in_pane("/cookie_page")

        self._wait.until(
            lambda _: "window_open_cookie" in (self._window_open_cookie_names() or []),
            message="The page sets its cookie in the window.open pane's own jar",
        )
        assert "window_open_cookie" not in self._forwarded_cookie_names(), (
            "Cookies set in the window.open pane are not forwarded after SSO"
        )
        self._driver.set_context("content")
