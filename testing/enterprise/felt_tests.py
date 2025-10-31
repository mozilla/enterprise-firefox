#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import datetime
import json
import shutil
import sys
import time
import urllib.parse
import uuid
from ctypes import c_wchar_p  # c_wchar_p
from http.server import BaseHTTPRequestHandler, HTTPServer
from multiprocessing import Manager, Process, Value

import requests
from base_test import EnterpriseTestsBase
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC


class LocalHttpRequestHandler(BaseHTTPRequestHandler):
    def reply(self, payload, code=200, status="Success"):
        self.send_response(code, status)
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

    def not_found(self, path=None):
        self.send_response(404, "Not Found")
        self.send_header("Content-Length", "0")
        self.end_headers()


class SsoHttpHandler(LocalHttpRequestHandler):
    def do_GET(self):
        print("GET", self.path)
        m = None

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        print("path: ", path)

        if path == "/sso_url":
            # Dummy sso login page
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

        elif path == "/auth":
            expires = datetime.datetime.utcnow() + datetime.timedelta(hours=8)
            cookie_expiry = expires.strftime("%a, %d %b %Y %H:%M:%S GMT")
            location = f"http://localhost:{self.server.console_port}/sso/callback?foo"
            self.send_response(302, "Found")
            self.send_header(
                "Set-Cookie",
                f"{self.server.cookie_name}={self.server.cookie_value}; Domain=localhost; Path=/; Expires={cookie_expiry}; SameSite=Strict",
            )
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if m is not None:
            self.reply(m)
        else:
            self.not_found(path)


class ConsoleHttpHandler(LocalHttpRequestHandler):
    def do_GET(self):
        print("GET", self.path)
        m = None

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        print("path: ", path)

        if path == "/sso/login":
            location = f"http://localhost:{self.server.sso_port}/sso_url"
            self.send_response(302, "Found")  # or 301/308 as needed
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        elif path == "/api/browser/hacks/default":
            # Browser prefs that can be applied live
            m = json.dumps(
                {
                    "prefs": [
                        ["browser.sessionstore.restore_on_demand", False],
                        ["browser.sessionstore.resume_from_crash", False],
                        ["browser.policies.live_polling.frequency", 500],
                    ]
                }
            )
        elif path == "/api/browser/hacks/startup":
            # Browser prefs that needs to be set in the prefs.js file
            m = json.dumps(
                {
                    "prefs": [
                        ["devtools.browsertoolbox.scope", "everything"],
                        ["marionette.port", 0],
                        ["enterprise.console.test_float", 1.5],
                        ["enterprise.console.test_bool", True],
                    ]
                }
            )

        elif path == "/api/browser/policies":
            auth = self.headers.get("Authorization")
            if not auth:
                self.reply("", 401, "Authorization required")
                return

            bearer = auth.split(" ")
            if len(bearer) != 2 or bearer[0].lower() != "bearer":
                self.reply("", 401, "Authorization required")
                return

            if bearer[1] != self.server.policy_access_token.value:
                self.reply("", 401, "Authorization required")
                return

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

        elif path == "/sso/callback":
            m = f"""
<html>
<head>
    <title>Callback!</title>
    <script id="token_data" type="application/json">
        {{"access_token":"{self.server.policy_access_token.value}","token_type":"bearer","expires_in":71999,"refresh_token":"{self.server.policy_refresh_token.value}"}}
    </script>
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
        if m is not None:
            self.reply(m)
        else:
            self.not_found(path)

    def do_POST(self):
        super().do_POST()

        print("POST", self.path)
        m = None

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        print("path: ", path)
        if path == "/sso/token":
            # Sending back the same session
            m = json.dumps(
                {
                    "access_token": self.server.policy_access_token.value,
                    "token_type": "Bearer",
                    "expires_in": 71999,
                    "refresh_token": self.server.policy_refresh_token.value,
                }
            )
        if m is not None:
            self.reply(m)
        else:
            self.not_found(path)


def serve(
    port,
    classname,
    sso_port,
    console_port,
    cookie_name=None,
    cookie_value=None,
    policy_block_about_config=None,
    policy_access_token=None,
    policy_refresh_token=None,
):
    httpd = HTTPServer(("", port), classname)
    httpd.sso_port = sso_port
    httpd.console_port = console_port
    if cookie_name is not None:
        httpd.cookie_name = cookie_name
    if cookie_value is not None:
        httpd.cookie_value = cookie_value
    if policy_block_about_config is not None:
        httpd.policy_block_about_config = policy_block_about_config
    if policy_access_token:
        httpd.policy_access_token = policy_access_token
    if policy_refresh_token:
        httpd.policy_refresh_token = policy_refresh_token
    print(
        f"Serving localhost:{port} SSO={sso_port} CONSOLE={console_port} with {classname}"
    )
    httpd.serve_forever()
    print(
        f"Stopped serving localhost:{port} SSO={sso_port} CONSOLE={console_port} with {classname}"
    )


class FeltTests(EnterpriseTestsBase):
    def __init__(
        self,
        json,
        firefox,
        geckodriver,
        profile_root,
        console,
        sso_server,
        test_prefs=[],
        cli_args=[],
        env_vars={},
    ):
        self._manually_closed_child = False
        self.console_port = console
        self.sso_port = sso_server
        self.policy_block_about_config = Value("B", 1)

        manager = Manager()
        self.policy_access_token = manager.Value(c_wchar_p, str(uuid.uuid4()))
        self.policy_refresh_token = manager.Value(c_wchar_p, str(uuid.uuid4()))

        print(f"Starting console server: {self.console_port}")
        self.console_httpd = Process(
            target=serve,
            args=(self.console_port, ConsoleHttpHandler),
            kwargs=dict(
                sso_port=self.sso_port,
                console_port=self.console_port,
                policy_block_about_config=self.policy_block_about_config,
                policy_access_token=self.policy_access_token,
                policy_refresh_token=self.policy_refresh_token,
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
                console_port=self.console_port,
                cookie_name=self.cookie_name,
                cookie_value=self.cookie_value,
            ),
        )
        self.sso_httpd.start()

        prefs = [
            ["enterprise.console.address", f"http://localhost:{self.console_port}"],
            ["enterprise.is_testing", True],
        ] + test_prefs

        super().__init__(
            json,
            firefox,
            geckodriver,
            profile_root,
            extra_cli_args=cli_args,
            extra_env=env_vars,
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

        # Pref does not like passing '\' ?
        if sys.platform == "win32":
            self._child_profile_path_value = self._child_profile_path.replace("\\", "/")
        else:
            self._child_profile_path_value = self._child_profile_path

        # self.set_string_pref("enterprise.console.address", console_addr)
        self.set_string_pref("enterprise.profile_path", self._child_profile_path_value)
        # self.set_bool_pref("enterprise.is_testing", True)

        self._driver.set_context("chrome")
        windows = len(self._driver.window_handles)
        self._logger.info(f"Checking number of windows: {windows}")
        assert windows == 1, "There should only be one Felt window"

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

    def get_pref_child(self, pref_name, pref_get):
        self._logger.info(f"Getting {pref_name}")
        self._child_driver.set_context("chrome")
        rv = self._child_driver.execute_script(
            f"return Services.prefs.get{pref_get}Pref('{pref_name}');"
        )
        self._logger.info(f"Pref value: {rv}")
        self._child_driver.set_context("content")
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
        self._driver.set_context("chrome")
        self._logger.info("Submitting email in chrome context ...")
        email = self.get_elem("#felt-form__email")
        self._logger.info(f"Submitting email in chrome context: {email}")

        # <moz-input-text> fails with 'unreachable by keyboard' in Selenium
        # because shadowroot does not delegate focus???
        # cf https://searchfox.org/firefox-main/rev/938e8f38c6765875e998d5c2965ad5864f5a5ee2/dom/base/nsFocusManager.cpp#5649
        self._driver.execute_script(
            """
            arguments[0].value = arguments[1];
            arguments[0].dispatchEvent(new Event('input', { bubbles: true }));
            """,
            email,
            "random@mozilla.com",
        )

        self._logger.info("Submitting email by clicking")
        btn = self.get_elem("#felt-form__sign-in-btn")
        btn.click()

        self._logger.info("Email submitted and SSO browser displayed")
        sso_content_ready = self.get_elem(".felt-login__sso")
        assert sso_content_ready, "The SSO content is displayed"
        self._logger.info(
            f"Email submitted and SSO browser displayed correctly: {sso_content_ready}"
        )

        self._driver.set_context("content")

        return True

    def test_felt_0_load_sso(self, exp):
        self._logger.info("Checking SSO page")
        for element in exp["elements"]:
            elem = self.get_elem(element[0])
            assert elem.get_property("name") == element[1], f"Has {element[1]} in page"
        self._logger.info("SSO page OK")

        return True

    def test_felt_1_perform_sso_auth(self, exp):
        self._logger.info("Performing SSO auth")
        self.get_elem("#login").send_keys("username@company.tld")
        self.get_elem("#password").send_keys("86c53cba7ccd")
        self.get_elem("#submit").click()
        self._logger.info("Performed SSO auth")

        return True
