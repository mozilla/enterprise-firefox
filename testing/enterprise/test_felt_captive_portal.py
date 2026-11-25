#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import sys

from marionette_driver import errors

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests

BANNER = ".felt-browser-error-captive-portal"
PORTAL_OVERLAY = ".felt-login__portal"
SSO_PANE = ".felt-login__sso"
EMAIL_PANE = ".felt-login__email-pane"
CONNECTION_ERROR = ".felt-browser-error-connection"


class FeltCaptivePortal(FeltTests):
    """
    Test the pre-auth captive-portal flow. The captive-portal
    state is driven by notifying the same observer topics CaptivePortalService
    fires, so the tests exercise the FELT UI wiring without needing a real
    portal on the network.

    Covered:
      - a detected portal shows the banner;
      - the banner's button opens the portal browser (loading the probe URL)
        and hides the banner;
      - clearing the portal (success) tears the portal browser down;
      - aborting the portal tears it down and returns to the login form;
      - a portal page that fails to load shows the connection error bar
        without leaving the portal;
      - a portal that interrupts an in-flight sign-in resumes it once cleared.
    """

    def setup(self):
        super().setup()
        # Serve the portal probe from the local console server so the portal
        # browser never reaches the real detectportal host, and the service
        # doesn't start polling it after we drive the login topics.
        self.set_string_pref(
            "captivedetect.canonicalURL",
            f"http://localhost:{self.console_port}/ping",
        )

    def teardown(self):
        # These tests never complete authentication, so there is no child
        # browser to tear down.
        self._manually_closed_child = True
        super().teardown()

    def _notify(self, topic):
        self._driver.set_context("chrome")
        self._driver.execute_script(
            "Services.obs.notifyObservers(null, arguments[0]);", [topic]
        )

    def _displayed(self, selector):
        return self.find_elem(selector).is_displayed()

    def _portal_uri(self):
        self._driver.set_context("chrome")
        return self._driver.execute_script(
            "return document.getElementById('portal-browser').currentURI.spec;"
        )

    def _portal_document_uri(self):
        self._driver.set_context("chrome")
        return self._driver.execute_script(
            "return document.getElementById('portal-browser').browsingContext"
            "?.currentWindowGlobal?.documentURI.spec ?? '';"
        )

    def _portal_is_remote(self):
        self._driver.set_context("chrome")
        return self._driver.execute_script(
            "return document.getElementById('portal-browser').isRemoteBrowser;"
        )

    def test_banner_opens_portal_browser(self):
        self._driver.set_context("chrome")
        assert not self._displayed(BANNER), "Banner is hidden before a portal is seen"

        self._notify("captive-portal-login")
        self._wait.until(
            lambda _: self._displayed(BANNER),
            message="Banner appears when a portal is detected",
        )

        self.find_elem_by_id("felt-open-network-login").click()
        self._wait.until(
            lambda _: self._displayed(PORTAL_OVERLAY) and not self._displayed(BANNER),
            message="Opening the portal shows the portal browser and hides the banner",
        )
        self._wait.until(
            lambda _: "/ping" in self._portal_uri(),
            message="The portal browser loads the probe URL",
        )
        # Untrusted portal content must run in a content process, not the parent
        # (it has no remote="true"; the switch is URL-driven on load).
        self._wait.until(
            lambda _: self._portal_is_remote(),
            message="The portal browser runs in a content process",
        )

        self._notify("captive-portal-login-success")
        self._wait.until(
            lambda _: (
                not self._displayed(PORTAL_OVERLAY) and not self._displayed(BANNER)
            ),
            message="Clearing the portal tears the portal browser down",
        )
        self._driver.set_context("content")

    def test_portal_abort_returns_to_login(self):
        self._driver.set_context("chrome")

        self._notify("captive-portal-login")
        self._wait.until(
            lambda _: self._displayed(BANNER),
            message="Banner appears when a portal is detected",
        )
        self.find_elem_by_id("felt-open-network-login").click()
        self._wait.until(
            lambda _: self._displayed(PORTAL_OVERLAY),
            message="Opening the portal shows the portal browser",
        )

        self._notify("captive-portal-login-abort")
        self._wait.until(
            lambda _: (
                not self._displayed(PORTAL_OVERLAY)
                and not self._displayed(BANNER)
                and self._displayed(EMAIL_PANE)
            ),
            message="Aborting the portal tears it down and returns to the login form",
        )
        self._driver.set_context("content")

    def test_portal_neterror_shows_connection_error(self):
        self.set_string_pref(
            "captivedetect.canonicalURL", "http://nonexistent.localdomain/"
        )
        self._driver.set_context("chrome")

        self._notify("captive-portal-login")
        self._wait.until(
            lambda _: self._displayed(BANNER),
            message="Banner appears when a portal is detected",
        )
        self.find_elem_by_id("felt-open-network-login").click()
        self._wait.until(
            lambda _: self._portal_document_uri().startswith("about:neterror"),
            message="The portal browser loads an error page",
        )

        self._wait.until(
            lambda _: self._displayed(CONNECTION_ERROR),
            message="A portal error page shows the connection error bar",
        )
        assert self.find_elem(CONNECTION_ERROR).get_attribute("source") == "net", (
            "The connection error bar comes from the error page"
        )
        assert self._displayed(PORTAL_OVERLAY), "The portal browser stays shown"
        self._driver.set_context("content")

    def test_sign_in_resumes_after_portal(self):
        self.run_felt_chrome_on_email_submit()
        self.run_wait_until_sso_loaded()

        # A portal appears mid-SSO: the banner shows and the UI flips back to
        # the login form (SSO pane hidden, email pane shown).
        self._notify("captive-portal-login")
        self._driver.set_context("chrome")
        self._wait.until(
            lambda _: (
                self._displayed(BANNER)
                and self._displayed(EMAIL_PANE)
                and not self._displayed(SSO_PANE)
            ),
            message="A portal mid-SSO shows the banner and returns to the login form",
        )

        # Clearing the portal resumes the same attempt: the SSO pane comes back
        # without the user re-submitting.
        self._notify("captive-portal-login-success")
        self._wait.until(
            lambda _: self._displayed(SSO_PANE) and not self._displayed(BANNER),
            message="Clearing the portal resumes the interrupted sign-in",
        )

        # The SSO browser still holds the stopped /sso_url from the first attempt,
        # so a plain URL/element check can grab the old document just as the resume
        # swaps it in. Wait for a stably-readable #login, tolerating that window.
        self._driver.set_context("content")

        def sso_reloaded(_):
            try:
                return (
                    self._driver.get_url().endswith("/sso_url")
                    and self.find_elem("#login").get_property("name") == "login"
                )
            except (errors.StaleElementException, errors.NoSuchElementException):
                return False

        self._wait.until(sso_reloaded, message="Resumed sign-in reloads the SSO page")
