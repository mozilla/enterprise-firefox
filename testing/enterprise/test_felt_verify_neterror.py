#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_console_error import FeltConsoleErrorBase


class FeltVerifyNetError(FeltConsoleErrorBase):
    def trigger_netError(self, error):
        self.reload_chrome_window()
        self._driver.set_context("chrome")
        self._driver.execute_async_script(
            """
            const callback = arguments[arguments.length - 1];
            const { FeltErrorReport } = ChromeUtils.importESModule("moz-src:///toolkit/components/felt/FeltErrorReport.sys.mjs");
            FeltErrorReport.handleNetError({errorPageURI: `about:neterror?e=${arguments[0]}&u=https%3A//www.mozilla.org`}).then(_ => callback());
            """,
            [error],
        )

    """
    This test is here to verify the rendering of about:neterror's error that
    are mapped into FeltErrorReport ONLY, there is no network involved.
    """

    def test_felt_neterror_handling(self):
        # We are not going to start the browser so do not try to close it
        self._manually_closed_child = True
        # Make sure the iteration and callable() check below will not choke on
        # this missing attribute
        self._child_driver = None

        object_methods = [
            method_name
            for method_name in dir(self)
            if callable(getattr(self, method_name))
            and method_name.startswith("run_netError")
        ]
        for m in object_methods:
            getattr(self, m)()

    # Generated from errorCode that can be found in toolkit/content/errors/net-errors.mjs:
    # $ for e in $(grep "errorCode:" toolkit/content/errors/net-errors.mjs | sed -e "s/^.*errorCode: //g" -e "s/,$//g" -e 's/"//g'); do echo -e "def run_netError_$e(self):\n     self.assert_error(\n        \"$e\",\n        \"title\",\n        \"error\",\n    )\n"; done;
    def run_netError_dnsNotFound(self):
        self.trigger_netError("dnsNotFound")
        self.assert_error_bar_message(
            selector=".felt-browser-error-connection",
            expected_heading="Server not found",
            error_msg="Try connecting on a different device. Check your modem or router. Disconnect and reconnect to Wi-Fi.",
            screenshot_name=f"{self._testMethodName}_dnsNotFound",
        )

    def run_netError_NS_ERROR_OFFLINE(self):
        self.trigger_netError("NS_ERROR_OFFLINE")
        self.assert_error_bar_message(
            selector=".felt-browser-error-connection",
            expected_heading="Looks like there’s a problem with your internet connection",
            error_msg="Try connecting on a different device. Check your modem or router. Disconnect and reconnect to Wi-Fi.",
            screenshot_name=f"{self._testMethodName}_NS_ERROR_OFFLINE",
        )

    def run_netError_netTimeout(self):
        self.trigger_netError("netTimeout")
        self.assert_error_bar_message(
            selector=".felt-browser-error-connection",
            expected_heading="The connection has timed out",
            error_msg="The server at www.mozilla.org is taking too long to respond.",
            screenshot_name=f"{self._testMethodName}_netTimeout",
        )

    def run_netError_blockedByPolicyEnterprise(self):
        self.trigger_netError("blockedByPolicyEnterprise")
        self.assert_error_bar_message(
            selector=".felt-browser-error-connection",
            expected_heading="Access to this site is restricted",
            error_msg="If you believe this is an error or need access for work purposes, please contact your IT administrator.",
            screenshot_name=f"{self._testMethodName}_blockedByPolicyEnterprise",
        )

    def run_netError_MOZILLA_PKIX_ERROR_MITM_DETECTED(self):
        self.trigger_netError("MOZILLA_PKIX_ERROR_MITM_DETECTED")
        self.assert_error_bar_message(
            selector=".felt-browser-error-connection",
            expected_heading="Unable to connect. Please contact your administrator.",
            error_msg=f"{self.get_brand_name()} spotted a potentially serious security issue with www.mozilla.org. Someone pretending to be the site could try to steal things like credit card info, passwords, or emails.",
            screenshot_name=f"{self._testMethodName}_MOZILLA_PKIX_ERROR_MITM_DETECTED",
        )

    def run_netError_netOffline(self):
        self.trigger_netError("netOffline")
        self.assert_error_bar_message(
            selector=".felt-browser-error-connection",
            expected_heading="Looks like there’s a problem with your internet connection",
            error_msg="Try connecting on a different device. Check your modem or router. Disconnect and reconnect to Wi-Fi.",
            screenshot_name=f"{self._testMethodName}_netOffline",
        )
