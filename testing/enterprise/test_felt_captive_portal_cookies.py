#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests

BANNER = ".felt-browser-error-captive-portal"
PORTAL_OVERLAY = ".felt-login__portal"

PORTAL_PAGE = b"""<!DOCTYPE html>
<meta charset="utf-8">
<script>
  document.cookie = "portal_load=1; path=/; max-age=3600";
  addEventListener("pagehide", () => {
    document.cookie = "portal_pagehide=1; path=/; max-age=3600";
  });
</script>
"""


class _PortalHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(PORTAL_PAGE)))
        self.end_headers()
        self.wfile.write(PORTAL_PAGE)

    def log_message(self, *args):
        pass


class FeltCaptivePortalCookies(FeltTests):
    """
    Cookies set by the captive portal stay in the portal's own jar and are not
    carried into the launched browser.
    """

    def setup(self):
        super().setup()
        self._portal_server = ThreadingHTTPServer(("127.0.0.1", 0), _PortalHandler)
        threading.Thread(target=self._portal_server.serve_forever, daemon=True).start()
        port = self._portal_server.server_address[1]
        self.set_string_pref(
            "captivedetect.canonicalURL", f"http://127.0.0.1:{port}/portal"
        )

    def teardown(self):
        self._portal_server.shutdown()
        self._portal_server.server_close()
        super().teardown()

    def _notify(self, topic):
        self._driver.set_context("chrome")
        self._driver.execute_script(
            "Services.obs.notifyObservers(null, arguments[0]);", [topic]
        )

    def _displayed(self, selector):
        return self.find_elem(selector).is_displayed()

    def _portal_cookies(self, driver, private_browsing_id):
        driver.set_context("chrome")
        return driver.execute_script(
            """
            return Services.cookies
              .getCookiesWithOriginAttributes(
                JSON.stringify({ privateBrowsingId: arguments[0] })
              )
              .filter(c => c.name.startsWith("portal_"))
              .map(c => ({ name: c.name, oa: c.originAttributes }));
            """,
            [private_browsing_id],
        )

    def test_portal_cookies_not_carried_into_browser(self):
        self._notify("captive-portal-login")
        self._wait.until(
            lambda _: self._displayed(BANNER), message="Portal banner appears"
        )
        self.find_elem_by_id("felt-open-network-login").click()
        self._wait.until(
            lambda _: any(
                c["name"] == "portal_load"
                for c in self._portal_cookies(self._driver, 1)
            ),
            message="Portal page set its cookie",
        )
        for c in self._portal_cookies(self._driver, 1):
            assert c["oa"]["privateBrowsingId"] == 1, c
            assert c["oa"]["userContextId"] == 1, c

        self._notify("captive-portal-login-success")
        self._wait.until(
            lambda _: not self._displayed(PORTAL_OVERLAY),
            message="Portal browser torn down",
        )
        self._wait.until(
            lambda _: any(
                c["name"] == "portal_pagehide"
                for c in self._portal_cookies(self._driver, 1)
            ),
            message="Portal set its pagehide cookie",
        )
        for c in self._portal_cookies(self._driver, 1):
            assert c["oa"]["userContextId"] == 1, c

        self.run_felt_base()
        self.connect_child_browser()

        child_cookies = self._portal_cookies(self._child_driver, 0)
        assert child_cookies == [], child_cookies
