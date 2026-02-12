#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import datetime
import json
import os
import random
import shutil
import sys
import tempfile
import time
import urllib.parse
import uuid
from ctypes import c_wchar_p
from http.server import BaseHTTPRequestHandler, HTTPServer
from multiprocessing import Manager, Process, Value

import felt_consts
import requests
from base_test import EnterpriseTestsBase
from marionette_driver import expected
from marionette_driver.by import By


class LocalHttpRequestHandler(BaseHTTPRequestHandler):
    def reply(self, payload, code=200, status="Success", contentType=None):
        self.send_response(code, status)
        if contentType:
            self.send_header("Content-Type", contentType)
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
            return json.dumps({})

        return None

    def not_found(self, path=None):
        self.send_response(404, "Not Found")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def forbidden(self, path=None):
        self.send_response(403, "Forbidden")
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
                f"{self.server.cookie_name.value}={self.server.cookie_value.value}; Domain=localhost; Path=/; Expires={cookie_expiry}; SameSite=Strict",
            )
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if m is not None:
            self.reply(m, contentType="text/html")
        else:
            self.not_found(path)


class ConsoleHttpHandler(LocalHttpRequestHandler):
    def check_auth(self):
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

    def do_GET(self):
        print("GET", self.path)
        m = None
        contentType = None

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        print("path: ", path)

        if path == "/sso/login":
            query = urllib.parse.parse_qs(parsed.query)
            if not "devicePostureToken" in query.keys():
                self.forbidden()
                return

            if query["devicePostureToken"][0] != self.server.device_posture_token:
                print(
                    f"Incorrect token. Expected '{self.server.device_posture_token}' received '{query['devicePostureToken'][0]}'"
                )
                self.forbidden()
                return

            location = f"http://localhost:{self.server.sso_port}/sso_url"
            self.send_response(302, "Found")  # or 301/308 as needed
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        elif path == "/api/browser/hacks/default":
            # Browser prefs that can be applied live
            m = json.dumps({
                "prefs": felt_consts.live_prefs
                + [
                    [
                        "identity.sync.tokenserver.uri",
                        "https://ent-dev-tokenserver.sync.nonprod.webservices.mozgcp.net/1.0/sync/1.5",
                    ]
                ]
            })
            contentType = "application/json"
        elif path == "/api/browser/hacks/startup":
            # Browser prefs that needs to be set in the prefs.js file
            m = json.dumps({
                "prefs": felt_consts.userjs_prefs + [["marionette.port", 0]],
            })
            contentType = "application/json"

        elif path == "/api/browser/policies":
            self.check_auth()
            policy_content = {}
            policy_value = (
                False if self.server.policy_block_about_config.value == 0 else True
            )
            policy_content.update(
                {"BlockAboutConfig": policy_value} if policy_value else {}
            )

            policy_value = self.server.policy_extensions.value == 1
            policy_content.update(
                {
                    "ExtensionSettings": {
                        "treestyletab@piro.sakura.ne.jp": {
                            "installation_mode": "force_installed",
                            "install_url": f"http://localhost:{self.server.console_port}/downloads/tree_style_tab-4.2.7.xpi",
                            "updates_disabled": True,
                        }
                    }
                }
                if policy_value
                else {}
            )

            m = json.dumps({"policies": policy_content})
            contentType = "application/json"

        elif path == "/api/browser/whoami":
            self.check_auth()

            m = json.dumps({
                "id": str(uuid.uuid4()),
                "email": "nobody@mozilla.org",
                "name": "moz user",
                "picture": f"http://localhost:{self.server.console_port}/avatar/something",
                "is_active": True,
                "last_login_at": "2025-11-14T14:27:23.575030Z",
                "created_at": "2025-10-31T15:11:50.735175Z",
                "updated_at": "2025-11-14T14:27:23.602803Z",
                "policy_roles_id": None,
            })
            contentType = "application/json"

        elif path == "/sso/callback":
            policy_access_token = self.server.policy_access_token.value
            policy_refresh_token = self.server.policy_refresh_token.value

            """
            TODO: Behavior is not yet clearly defined
            with self.server.device_posture_reply_forbidden.get_lock():
                if self.server.device_posture_reply_forbidden.value == 1:
                    policy_access_token = ""
                    policy_refresh_token = ""
            """

            obj = json.dumps({
                "access_token": f"{policy_access_token}",
                "token_type": "bearer",
                "expires_in": 71999,
                "refresh_token": f"{policy_refresh_token}",
            })

            m = f"""
<html>
<head>
    <title>Callback!</title>
    <script id="token_data" type="application/json">{obj}</script>
</head>
<body>
    <h1>Welcome!</h1>
</body>
</html>
            """
            contentType = "text/html"

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
            contentType = "text/html"

        # Not a real end point, just used for tests
        elif path == "/sso/get_device_posture":
            m = json.dumps(self.server.device_posture_payload)
            contentType = "application/json"

        elif path.startswith("/downloads/"):
            filename = os.path.join(os.path.dirname(__file__), os.path.basename(path))
            if os.path.isfile(filename):
                with open(filename, mode="rb") as file:
                    content = file.read()

                self.send_response(200, "Success")
                self.send_header("Content-type", "application/x-xpinstall")
                self.send_header("Content-Length", len(content))
                self.end_headers()

                self.wfile.write(bytes(content))
                return

        if m is not None:
            self.reply(m, contentType=contentType)
        else:
            self.not_found(path)

    def do_POST(self):
        print("POST", self.path)
        m = super().do_POST()

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        print("path: ", path)
        if path == "/sso/token":
            # Sending back the same session
            m = json.dumps({
                "access_token": self.server.policy_access_token.value,
                "token_type": "Bearer",
                "expires_in": 71999,
                "refresh_token": self.server.policy_refresh_token.value,
            })

        elif path == "/sso/device_posture":
            self.server.device_posture_payload = json.loads(
                self.rfile.read(int(self.headers.get("Content-Length")))
            )
            self.server.device_posture_token = str(uuid.uuid4())
            m = json.dumps({"posture": self.server.device_posture_token})

        elif path == "/sso/logout":
            self.check_auth()
            m = json.dumps(None)

        if m is not None:
            self.reply(m, contentType="application/json")
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
    policy_extensions=None,
    policy_access_token=None,
    policy_refresh_token=None,
    # TODO: Behavior is not yet clearly defined
    # device_posture_reply_forbidden=None,
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
    if policy_extensions is not None:
        httpd.policy_extensions = policy_extensions
    if policy_access_token:
        httpd.policy_access_token = policy_access_token
    if policy_refresh_token:
        httpd.policy_refresh_token = policy_refresh_token
    """
    TODO: Behavior is not yet clearly defined
    if device_posture_reply_forbidden is not None:
        httpd.device_posture_reply_forbidden = device_posture_reply_forbidden
    """
    print(
        f"Serving localhost:{port} SSO={sso_port} CONSOLE={console_port} with {classname}"
    )
    httpd.serve_forever()
    print(
        f"Stopped serving localhost:{port} SSO={sso_port} CONSOLE={console_port} with {classname}"
    )


class FeltTestsBase(EnterpriseTestsBase):
    EXTRA_ENV = {}

    def setUp(self):
        # test_prefs = kwargs.get("test_prefs", [])

        self._manually_closed_child = False
        self.console_port = random.randrange(10000, 14999)
        self.sso_port = random.randrange(15000, 20000)
        self.policy_block_about_config = Value("B", 1)
        self.policy_extensions = Value("B", 0)
        """
        TODO: Behavior is not yet clearly defined
        self.device_posture_reply_forbidden = Value("B", 0)
        """

        self._extra_prefs = {
            "enterprise.console.address": f"http://localhost:{self.console_port}",
            "enterprise.is_testing": True,
        }  # + test_prefs

        if hasattr(self, "EXTRA_PREFS"):
            self._extra_prefs.update(self.EXTRA_PREFS)

        manager = Manager()
        self.policy_access_token = manager.Value(c_wchar_p, str(uuid.uuid4()))
        self.policy_refresh_token = manager.Value(c_wchar_p, str(uuid.uuid4()))

        self.console_httpd = Process(
            target=serve,
            args=(self.console_port, ConsoleHttpHandler),
            kwargs=dict(
                sso_port=self.sso_port,
                console_port=self.console_port,
                policy_block_about_config=self.policy_block_about_config,
                policy_extensions=self.policy_extensions,
                policy_access_token=self.policy_access_token,
                policy_refresh_token=self.policy_refresh_token,
                # TODO: Behavior is not yet clearly defined
                # device_posture_reply_forbidden=self.device_posture_reply_forbidden,
            ),
        )
        self.console_httpd.start()

        self.cookie_name = manager.Value(c_wchar_p, str(uuid.uuid1()).split("-")[0])
        self.cookie_value = manager.Value(c_wchar_p, str(uuid.uuid4()).split("-")[4])
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

        self._profile_root = tempfile.mkdtemp(prefix="mozrunner-enterprise-test")

        if "MOZ_BYPASS_FELT" in os.environ.keys():
            del os.environ["MOZ_BYPASS_FELT"]

        super().setUp()

        self._logger.info(f"Starting console server: {self.console_port}")
        self._logger.info(f"Starting SSO server: {self.sso_port}")

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

        self.set_string_pref("enterprise.profile_path", self._child_profile_path_value)

        self._driver.set_context("chrome")
        self._wait.until(lambda mn: len(mn.chrome_window_handles) == 1)
        windows = len(self._driver.chrome_window_handles)
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

        self._logger.info("Shutting down console")
        requests.post(f"http://localhost:{self.console_port}/:shutdown", timeout=2)
        self._logger.info("Shutting down SSO")
        requests.post(f"http://localhost:{self.sso_port}/:shutdown", timeout=2)
        self._logger.info("Stopping process console")
        self.console_httpd.join()
        self._logger.info("Stopping process SSO")
        self.sso_httpd.join()
        self._logger.info("All stopped")

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

    def _get_elem(self, el, driver, waiter, long_waiter):
        # Windows is slower?
        found = False
        if sys.platform == "win32":
            found = long_waiter.until(expected.element_displayed(By.CSS_SELECTOR, el))
        else:
            found = waiter.until(expected.element_displayed(By.CSS_SELECTOR, el))
        if found:
            return driver.find_element(By.CSS_SELECTOR, el)
        else:
            raise ValueError

    def get_elem(self, e):
        return self._get_elem(e, self._driver, self._wait, self._longwait)

    def get_elem_child(self, e):
        return self._get_elem(
            e,
            self._child_driver,
            self._child_wait,
            self._child_longwait,
        )

    def find_elem_by_id(self, e):
        return self._driver.find_element(By.ID, e)

    def find_elem_child(self, e):
        return self._child_driver.find_element(By.CSS_SELECTOR, e)

    def wait_process_exit(self):
        self._logger.info("Waiting a few seconds ...")
        if sys.platform == "win32":
            time.sleep(8)
        else:
            time.sleep(3)
        self._logger.info(f"Checking PID {self._browser_pid}")

        import psutil

        if not psutil.pid_exists(self._browser_pid):
            self._logger.info(f"No more PID {self._browser_pid}")
        else:
            try:
                process = psutil.Process(pid=self._browser_pid)
                process_name = process.name()
                process_exe = process.exe()
                process_basename = os.path.basename(process_name)
                process_cmdline = process.cmdline()
                self._logger.info(
                    f"Found PID {self._browser_pid}: EXE:{process_exe} :: NAME:{process_name} :: CMDLINE:{process_cmdline} :: BASENAME:'{process_basename}'"
                )
                assert process_basename != "firefox", "Process is not Firefox"
            except psutil.ZombieProcess:
                self._logger.info(f"Zombie found as {self._browser_pid}")

    def run_felt_base(self):
        self.run_felt_chrome_on_email_submit()
        self.run_felt_load_sso()
        self.run_felt_perform_sso_auth()

    def submit_email(self, email_address="random@mozilla.com"):
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
            [email, email_address],
        )

        self._logger.info("Submitting email by clicking")
        btn = self.get_elem("#felt-form__sign-in-btn")
        btn.click()
        self._driver.set_context("content")


class FeltTests(FeltTestsBase):
    def run_felt_chrome_on_email_submit(self):
        self.submit_email()

        self._driver.set_context("chrome")
        self._logger.info("Email submitted and SSO browser displayed")
        sso_content_ready = self.get_elem(".felt-login__sso")
        assert sso_content_ready, "The SSO content is displayed"
        self._logger.info(
            f"Email submitted and SSO browser displayed correctly: {sso_content_ready}"
        )
        self._driver.set_context("content")

    def run_felt_load_sso(self):
        self._logger.info("Checking SSO page")
        self._driver.set_context("content")
        self._wait.until(lambda mn: mn.get_url().endswith("/sso_url"))
        self._logger.info(f"URL {self._driver.get_url()}")
        assert self.get_elem("#login").get_property("name") == "login", (
            "Has 'login' in page"
        )
        assert self.get_elem("#password").get_property("name") == "password", (
            "Has 'password' in page"
        )
        self._logger.info("SSO page OK")

    def run_felt_perform_sso_auth(self):
        self._logger.info("Performing SSO auth")
        self._wait.until(lambda mn: mn.get_url().endswith("/sso_url"))
        self._logger.info(f"URL {self._driver.get_url()}")
        self.get_elem("#login").send_keys("username@company.tld")
        self.get_elem("#password").send_keys("86c53cba7ccd")
        self.get_elem("#submit").click()
        self._logger.info("Performed SSO auth")

    def await_felt_auth_window(self):
        self._wait.until(lambda mn: len(self._driver.chrome_window_handles) == 1)
