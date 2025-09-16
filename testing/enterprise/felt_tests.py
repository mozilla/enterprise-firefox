#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import datetime
import json
import os
import shutil
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from multiprocessing import Process, Value

import requests
from base_test import EnterpriseTestsBase
from selenium.common.exceptions import (
    NoSuchWindowException,
    WebDriverException,
)
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC


class LocalHttpRequestHandler(BaseHTTPRequestHandler):
    def reply(self, payload):
        self.send_response(200, "Success")
        self.send_header("Content-Length", len(payload))
        self.end_headers()
        self.wfile.write(bytes(payload, "utf8"))

    def do_POST(self):
        print("POST", self.path)

        if self.path == "/:shutdown":
            print("Shutting down as requested")
            self.reply("OK")
            setattr(self.server, "_BaseServer__shutdown_request", True)
            self.server.server_close()


class SsoHttpHandler(LocalHttpRequestHandler):
    def do_GET(self):
        print("GET", self.path)
        m = None

        try:
            (path, query) = self.path.split("?")
        except ValueError:
            path = self.path

        if path == "/sso_url":
            m = """
<html>
<head>
    <title>SSO!</title>
</head>
<body>
    <form action="/auth">
        <label for="login">Login:</label><br />
        <input type="text" id="login" name="login"><br/>
        <label for="password">Password:</label><br />
        <input type="password" id="password" name="password"><br />
        <input type="submit" id="submit" value="Authenticate">
    </form>
</body>
</html>
            """

        elif path == "/dashboard":
            m = """
<html>
<head>
    <title>Dashboard!</title>
</head>
<body>
    <h1>Welcome!</h1>
</body>
</html>
            """

        elif path == "/redirect_after_sso":
            m = """
<html>
<head>
    <title>Landing page!</title>
</head>
<body>
    <h1>New page</h1>
</body>
</html>
            """

        elif path == "/sso_page":
            m = """
<html>
<head>
    <title>SSO Page!</title>
</head>
<body>
    <h1>This is the SSO page for the Firefox instance</h1>
</body>
</html>
            """

        elif path == "/auth":
            expires = datetime.datetime.utcnow() + datetime.timedelta(hours=8)
            cookie_expiry = expires.strftime("%a, %d %b %Y %H:%M:%S GMT")
            self.send_response(301, "Moved Permanently")
            self.send_header(
                "Set-Cookie",
                f"{self.server.cookie_name}={self.server.cookie_value}; Domain=localhost; Path=/; Expires={cookie_expiry}; SameSite=Strict",
            )
            self.send_header(
                "Location", f"http://localhost:{self.server.sso_port}/dashboard"
            )
            self.end_headers()

        if m:
            self.reply(m)


class ConsoleHttpHandler(LocalHttpRequestHandler):
    def do_GET(self):
        print("GET", self.path)
        m = None

        try:
            (path, query) = self.path.split("?")
        except ValueError:
            path = self.path

        # Handling of Firefox NON FELT prefs
        if path == "/default":
            m = json.dumps(
                {
                    "prefs": [
                        ["devtools.browsertoolbox.scope", "everything"],
                        ["browser.felt.enabled", False],
                        ["browser.sessionstore.restore_on_demand", False],
                        ["browser.sessionstore.resume_from_crash", False],
                        ["marionette.port", 0],
                        ["browser.policies.live_polling_freq", 500],
                    ]
                }
            )

        elif path == "/policies":
            if hasattr(self.server, "policy_block_about_config"):
                with self.server.policy_block_about_config.get_lock():
                    policy_value = (
                        False
                        if self.server.policy_block_about_config.value == 0
                        else True
                    )
                    m = json.dumps({"policies": {"BlockAboutConfig": policy_value}})
            else:
                m = json.dumps({"policies": {}})

        elif path == "/dashboard":
            m = """
<html>
<head>
    <title>Dashboard!</title>
</head>
<body>
    <h1>Welcome!</h1>
</body>
</html>
            """

        elif path == "/ping":
            m = """
<html>
<head>
    <title>Pong!</title>
</head>
<body>
</body>
</html>
            """

        if m:
            self.reply(m)


def serve(
    port,
    classname,
    sso_port,
    cookie_name=None,
    cookie_value=None,
    policy_block_about_config=None,
):
    httpd = HTTPServer(("", port), classname, sso_port)
    httpd.sso_port = sso_port
    if cookie_name:
        httpd.cookie_name = cookie_name
    if cookie_value:
        httpd.cookie_value = cookie_value
    if policy_block_about_config:
        httpd.policy_block_about_config = policy_block_about_config
    print(f"Serving localhost:{port} SSO={sso_port} with {classname}")
    httpd.serve_forever()
    print(f"Stopped serving localhost:{port} SSO={sso_port} with {classname}")


class FeltTests(EnterpriseTestsBase):
    def __init__(self, json, firefox, geckodriver, profile_root, console, sso_server, test_prefs=[]):
        self._manually_closed_child = False
        self.console_port = console
        self.sso_port = sso_server
        self.policy_block_about_config = Value("B", 1)

        print(f"Starting console server: {self.console_port}")
        self.console_httpd = Process(
            target=serve,
            args=(self.console_port, ConsoleHttpHandler),
            kwargs=dict(
                sso_port=self.sso_port,
                policy_block_about_config=self.policy_block_about_config,
            ),
        )
        self.console_httpd.start()

        self.cookie_name = str(uuid.uuid1()).split("-")[0]
        self.cookie_value = str(uuid.uuid4()).split("-")[4]
        print(f"Starting SSO server: {self.sso_port}")
        self.sso_httpd = Process(
            target=serve,
            args=(self.sso_port, SsoHttpHandler),
            kwargs=dict(
                sso_port=self.sso_port,
                cookie_name=self.cookie_name,
                cookie_value=self.cookie_value,
            ),
        )
        self.sso_httpd.start()

        prefs = [
            ["browser.felt.console", f"http://localhost:{self.console_port}"],
            ["browser.felt.sso_url", f"http://localhost:{self.sso_port}/sso_url"],
            # Bug? matcher https://searchfox.org/firefox-main/source/toolkit/components/extensions/MatchPattern.cpp#370-384
            # ends up with mDomain=localhost:8000 and aDomain=localhost
            # for pref value http://localhost/dashboard
            ["browser.felt.matches", "http://localhost/dashboard"],
            [
                "browser.felt.redirect_after_sso",
                f"http://localhost:{self.sso_port}/redirect_after_sso",
            ],
        ] + test_prefs

        super(__class__, self).__init__(
            json,
            firefox,
            geckodriver,
            profile_root,
            extra_cli_args=["-feltUI"],
            extra_prefs=prefs,
            dont_maximize=True,
        )

    def setup(self):
        console_addr = f"http://localhost:{self.console_port}"

        max_try = 0
        while max_try < 20:
            max_try += 1
            try:
                r = requests.get(f"{console_addr}/ping")
                print("r", r)
                break
            except Exception as ex:
                self._logger.info(f"Console not yet online at {console_addr}: {ex}")
                time.sleep(0.5)

        self._child_profile_path = self.get_profile_path(
            name="enterprise-tests-browser"
        )
        self._logger.info(f"Using browser profile at {self._child_profile_path}")

        self._logger.info(
            f"Setting prefs for browser profile {self._child_profile_path}"
        )
        with open(os.path.join(self._child_profile_path, "user.js"), "w") as user_pref:
            user_pref.write('user_pref("marionette.port", 0);')

        # Pref does not like passing '\' ?
        if sys.platform == "win32":
            self._child_profile_path_value = self._child_profile_path.replace("\\", "/")
        else:
            self._child_profile_path_value = self._child_profile_path

        self.set_string_pref("browser.felt.console", console_addr)
        self.set_string_pref(
            "browser.felt.profile_path", self._child_profile_path_value
        )
        self.set_bool_pref("browser.felt.is_testing", True)

        # self.switch_to_felt_chrome_context()
        self.set_felt_window()

    def teardown(self):
        if not self._manually_closed_child:
            self._logger.info("Closing browser")
            self._child_driver.set_context("chrome")
            self._child_driver.execute_script(
                "Services.startup.quit(Ci.nsIAppStartup.eForceQuit);"
            )
            self._logger.info("Closed browser")
        else:
            self._logger.info("Browser was already manually closed.")

        print("Shutting down console")
        requests.post(f"http://localhost:{self.console_port}/:shutdown", timeout=2)
        print("Shutting down SSO")
        requests.post(f"http://localhost:{self.sso_port}/:shutdown", timeout=2)
        print("Stopping process console")
        self.console_httpd.join()
        print("Stopping process SSO")
        self.sso_httpd.join()
        print("All stopped")

        self._logger.info(f"Removing browser profile at {self._child_profile_path}")
        shutil.rmtree(self._child_profile_path, ignore_errors=True)

    def set_string_pref(self, pref_name, pref_value):
        self._logger.info(f"Setting {pref_name} to {pref_value}")
        self._driver.set_context("chrome")
        rv = self._driver.execute_script(
            f"Services.prefs.setStringPref('{pref_name}', '{pref_value}'); return Services.prefs.getStringPref('{pref_name}');"
        )
        self._logger.info(f"Pref value: {rv}")
        self._driver.set_context("content")
        return rv

    def set_bool_pref(self, pref_name, pref_value):
        self._logger.info(f"Setting {pref_name} to {pref_value}")
        self._driver.set_context("chrome")
        rv = self._driver.execute_script(
            f"Services.prefs.setBoolPref('{pref_name}', '{pref_value}'); return Services.prefs.getBoolPref('{pref_name}');"
        )
        self._logger.info(f"Pref value: {rv}")
        self._driver.set_context("content")
        return rv

    def get_felt_enabled_pref(self):
        self._driver.set_context("chrome")
        rv = self._driver.execute_script(
            "try { return Services.prefs.getBoolPref('browser.felt.enabled'); } catch { return false; }"
        )
        self._logger.info(f"Pref value: {rv}")
        self._driver.set_context("content")
        return rv

    def set_felt_window(self):
        self._logger.info(f"Searching FELT in {self._driver.window_handles}")
        # self._driver.window_handles is returning content windows.
        # We could use chrome_window_handles but "AttributeError: 'WebDriver' object has no attribute 'chrome_window_handles'"
        for win in self._driver.window_handles:
            self._logger.info(f"Testing for FELT at {win}")
            self._driver.switch_to.window(win)
            self._logger.info(f"Switched to {win}: {self._driver.current_url}")
            if self._driver.current_url == "chrome://felt/content/feltui.xhtml":
                self._logger.info(f"Found FELT at {win}")
                return

    def switch_to_felt_chrome_context(
        self, name="felt", path="chrome://felt/content/felt.xhtml"
    ):

        self._logger.info("Checking FELT pref")
        assert self.get_felt_enabled_pref() is True, "pref should be enabled"

        self._logger.info(f"Waiting for chrome window {path}.")
        self._driver.set_context("chrome")
        self._longwait.until(
            lambda d: self._driver.execute_script(
                """
            let e = Services.wm.getEnumerator(null);
            while (e.hasMoreElements()) {
                let w = e.getNext();
                if (w.document?.documentURI === arguments[1]) {
                    if (!w.name) w.name = arguments[0];
                    return true;
                }
            }
            return false;
        """,
                name,
                path,
            )
        )

        self._logger.info(f"Switching to chrome context of window {name}")
        self._longwait.until(lambda d: self.switch_window_by_name(name))

        ok = self._driver.execute_script(
            "return window.document?.documentURI === arguments[0];", path
        )
        assert ok, f"Expected chrome window {path}, got a different window"

    def switch_window_by_name(self, name):
        try:
            self._driver.switch_to.window(name)
            return True
        except NoSuchWindowException:
            return False

    def get_elem(self, e):
        # Windows is slower?
        if sys.platform == "win32":
            return self._longwait.until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, e))
            )
        else:
            return self._wait.until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, e))
            )

    def get_elem_child(self, e):
        # Windows is slower?
        if sys.platform == "win32":
            return self._child_longwait.until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, e))
            )
        else:
            return self._child_wait.until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, e))
            )

    def test_felt_00_chrome_on_email_submit(self, exp):

        # Tried it as well with .using_context,
        # AttributeError: 'WebDriver' object has no attribute 'using_context'
        self._driver.set_context("chrome")
        self._logger.info("Submitting email in chrome context ...")
        email = self.get_elem("#felt-login__form-email")
        self._logger.info(f"Submitting email in chrome context: {email}")

        # <moz-input-text> fails with 'unreachable by keyboard' in Selenium
        # because shadowroot does not delegate focus???
        # cf https://searchfox.org/firefox-main/rev/938e8f38c6765875e998d5c2965ad5864f5a5ee2/dom/base/nsFocusManager.cpp#5649
        self._driver.execute_script(
            """
            arguments[0].value = arguments[1];
            arguments[0].dispatchEvent(new Event('input', { bubbles: true }));
            """, email, "random@mozilla.com")

        self._logger.info("Submitting email by clicking")
        btn = self.get_elem("#felt-login__form-sign-in-btn")
        btn.click()

        self._logger.info("Email submitted and SSO browser displayed")
        sso_content_ready = self.get_elem(".felt-login__sso")
        assert sso_content_ready, "The SSO content is displayed"
        self._logger.info(f"Email submitted and SSO browser displayed correctly: {sso_content_ready}")

        self._driver.set_context("content")

        return True

    def test_felt_0_load_sso(self, exp):
        self._logger.info("Checking SSO page")
        for element in exp["elements"]:
            elem = self.get_elem(element[0])
            assert elem.get_property("name") == element[1], f"Has {element[1]} in page"
        self._logger.info("SSO page OK")

        return True

    def test_felt_1_dashboard(self, exp):
        self._logger.info("Performing SSO auth")
        self.get_elem("#login").send_keys("username@company.tld")
        self.get_elem("#password").send_keys("86c53cba7ccd")
        self.get_elem("#submit").click()
        self._logger.info("Performed SSO auth")

        return True

    def test_felt_2_redirect_after_sso(self, exp):
        expected_cookie = list(
            filter(
                lambda x: x["name"] == self.cookie_name
                and x["value"] == self.cookie_value,
                self._driver.get_cookies(),
            )
        )
        assert len(expected_cookie) == 1, f"Cookie {self.cookie_name} was properly set"

        return True
