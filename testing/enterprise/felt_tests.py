#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import base64
import ctypes
import datetime
import json
import os
import secrets
import shutil
import socket
import sys
import tempfile
import time
import urllib.parse
import uuid
from contextlib import closing, contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from multiprocessing import Array, Process, Value

import requests
from base_test import EnterpriseTestsBase
from felt_consts import firefox_config
from marionette_driver import expected
from marionette_driver.by import By
from marionette_driver.geckoinstance import DesktopInstance, GeckoInstance
from mozprofile.prefs import Preferences


class SharedString:
    """Process-safe string backed by shared memory.

    Replaces Manager.Value(c_wchar_p, ...) to avoid the Manager IPC path, which
    pickles data into a memoryview. Under GC pressure that memoryview can be
    collected while still exported, triggering a CPython bug (bpo-77894 /
    cpython#123898) that crashes the Manager's ServerProxy processes.
    Using a shared memory Array avoids all IPC and memoryview allocation.
    """

    _MAX_SIZE = 128

    def __init__(self, initial=""):
        self._array = Array(ctypes.c_char, self._MAX_SIZE)
        self.value = initial

    @property
    def value(self):
        with self._array.get_lock():
            return self._array._obj.value.decode("utf-8")

    @value.setter
    def value(self, s):
        encoded = s.encode("utf-8")
        assert len(encoded) < self._MAX_SIZE, (
            f"SharedString value too long: {len(encoded)} >= {self._MAX_SIZE}"
        )
        with self._array.get_lock():
            self._array._obj.value = encoded


class ConsoleSSOPortMixin:
    """Provides console_port/sso_port properties that block until the
    server processes have bound to their OS-assigned ports (port 0).
    Expects _console_port and _sso_port to be multiprocessing.Value("i", 0)."""

    def _wait_for_port(self, val):
        for _ in range(40):
            if val.value != 0:
                return val.value
            time.sleep(0.5)
        raise RuntimeError("Server failed to start")

    @property
    def console_port(self):
        return self._wait_for_port(self._console_port)

    @property
    def sso_port(self):
        return self._wait_for_port(self._sso_port)


class ConsoleSSOHTTPServer(ConsoleSSOPortMixin, HTTPServer):
    pass


# A fresh random primarySecret per test-run process, served at /api/browser/key.
# Stable across the in-run browser restarts that reuse a profile (so the Password
# KEK keeps unlocking the per-DB DEKs), but random across runs to avoid any
# stale-cache reuse.
TEST_PRIMARY_SECRET = secrets.token_hex(32)


class LocalHttpRequestHandler(BaseHTTPRequestHandler):
    def reply(self, payload, code=200, status="Success", contentType=None):
        self.send_response(code, status)
        if contentType:
            self.send_header("Content-Type", contentType)
        self.send_header("Content-Length", len(payload))
        self.end_headers()
        self.wfile.write(bytes(payload, "utf8"))

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
    def build_policies_response(self):
        policy_content = {}

        # Reflect the states:
        #  - "Unset" is -1, no value is pushed
        #  - "False" is 0
        #  - "True" is 1
        if self.server.policy_block_about_config.value >= 0:
            policy_content.update({
                "BlockAboutConfig": self.server.policy_block_about_config.value == 1
            })

        if self.server.policy_access_connector.value == 1:
            policy_content.update({
                "AccessConnector": {
                    "Host": "proxy",
                    "MatchPatterns": [
                        "https://*.mozilla.org",
                    ],
                    "Port": 18443,
                }
            })

        if self.server.policy_extensions.value == 1:
            policy_content.update({
                "ExtensionSettings": {
                    "treestyletab@piro.sakura.ne.jp": {
                        "installation_mode": "force_installed",
                        "install_url": f"http://localhost:{self.server.console_port}/downloads/tree_style_tab-4.2.7.xpi",
                        "updates_disabled": True,
                    }
                }
            })

        return json.dumps({"policies": policy_content})

    def check_auth(self):
        auth = self.headers.get("Authorization")
        if not auth:
            self.reply("", 401, "Authorization required")
            return False

        bearer = auth.split(" ")
        if len(bearer) != 2 or bearer[0].lower() != "bearer":
            self.reply("", 401, "Authorization required")
            return False

        if bearer[1] != self.server.policy_access_token.value:
            self.reply("", 401, "Authorization required")
            return False

        return True

    def do_GET(self):
        print("GET", self.path)
        m = None
        contentType = None

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        print("path: ", path)

        if path == "/sso/login":
            query = urllib.parse.parse_qs(parsed.query)
            if (
                not "devicePostureToken" in query.keys()
                or not "deviceId" in query.keys()
            ):
                self.forbidden()
                return

            if query["devicePostureToken"][0] != self.server.device_posture_token:
                print(
                    f"Incorrect token. Expected '{self.server.device_posture_token}' received '{query['devicePostureToken'][0]}'"
                )
                self.forbidden()
                return

            location = f"http://localhost:{self.server.sso_port}/sso_url"
            if self.server.login_location.value != "":
                location = self.server.login_location.value
            self.send_response(302, "Found")  # or 301/308 as needed
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        elif path == "/api/browser/config":
            m = json.dumps({
                "learn_more_url": firefox_config["learn_more_url"]["pref_value"],
                "company_logo_url": "",
                "policies": {"polling_frequency": 500},
                "services": {
                    "push_url": "",
                    "remote_settings_url": "",
                    "tokenserver_url": "",
                },
                "extra_prefs": [["marionette.port", 0]],
            })

        elif path == "/api/browser/key":
            if not self.check_auth():
                return
            if self.server.key_fail_request.value:
                self.reply("", 500, "Internal Server Error", "application/json")
                return
            # The primarySecret for SQLite at-rest encryption. The Felt UI
            # process fetches it (ConsoleClient.getPrimarySecret ->
            # /api/browser/key) before spawning Firefox and forwards it as the
            # Password KEK password; without it the spawned browser cannot open
            # its encrypted profile databases.
            m = json.dumps({"data": TEST_PRIMARY_SECRET})
            contentType = "application/json"

        elif path == "/api/browser/whoami":
            if not self.check_auth():
                return

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

        elif path == "/api/browser/forced_updates_count":
            """
            This is a test only endpoint to verify how many updates were served
            """

            m = json.dumps({
                "serve_forced_updates_count": self.server.serve_forced_updates_count
            })
            contentType = "application/json"

        # /api/browser/updates/FirefoxEnterprise/149.0a1/20260218134117/Linux_x86_64-gcc3/en-US/default/Linux%25206.17.0-8-generic%2520(GTK%25203.24.50%252Clibpulse%252017.0.0)/ISET%3ASSE4_2%2CMEM%3A85823/default/default/update.xml?force=1"
        elif path.startswith("/api/browser/updates"):
            # Producing this requires:
            # $ mach build && mach package
            # then extract the tar somewhere, you have firefox/
            # make a firefox.work/ next to firefox/ and copy what you want from firefox/ to firefox.work/
            # then, e.g. to package only "application.ini"
            # $ ~/.mozbuild/mar-tools/mar -V 149.0a1 -H enterprise-tests -C "./firefox.work/" -c output.mar "application.ini"
            complete_mar = os.path.join(
                os.path.dirname(__file__), os.path.basename("complete.mar")
            )
            if self.server.serve_updates and os.path.isfile(complete_mar):
                # Versions are important, they need to be equal or higher than the
                # current binary otherwise no update will be downloaded
                display_version = self.server.serve_updates_version[
                    "application_version"
                ][0]
                app_version = self.server.serve_updates_version["application_version"][
                    0
                ]
                platform_version = self.server.serve_updates_version[
                    "platform_version"
                ][0]
                # BuildID also needs to be different, fake it as newer
                build_id = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
                # Hash is not verified client side? At least we can put what we want
                hash_value = "ecee0f4b9f0af06cfa3a89c328e4cbb7dd075a0d411ef1b968a072a7995a0753dd96d3d541f0781ab95fdb61e3df7252a9379fc620f2b660ecaed582f2c5246d"

                size = os.stat(complete_mar).st_size
                m = f"""<?xml version="1.0"?>
<updates>
    <update type="minor" displayVersion="{display_version}" appVersion="{app_version}" platformVersion="{platform_version}" buildID="{build_id}">
        <patch type="complete" URL="http://localhost:{self.server.console_port}/downloads/complete.mar" hashFunction="sha512" hashValue="{hash_value}" size="{size}"/>
    </update>
</updates>"""
            else:
                m = """<?xml version="1.0"?><updates></updates>"""

            if "?force=1" in self.path:
                self.server.serve_forced_updates_count += 1

            contentType = "text/xml"

        elif path == "/api/v1/fpn/token":
            now = int(time.time())
            body = {
                "sub": "test",
                "aud": f"http://localhost:{self.server.console_port}",
                "iat": now,
                "nbf": now,
                "exp": now + 3600,
                "iss": "test",
            }
            encoded = base64.b64encode(json.dumps(body).encode()).decode()
            m = json.dumps({
                # header.body.signature
                "token": f"fxn.{encoded}.token"
            })
            contentType = "application/json"

        elif path == "/sso/callback":
            self.server.policy_access_token.value = str(uuid.uuid4())
            self.server.policy_refresh_token.value = str(uuid.uuid4())
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

        elif path == "/sso/get_device_posture_history":
            history = getattr(self.server, "device_posture_history", [])
            m = json.dumps(history)
            contentType = "application/json"

        elif path.startswith("/downloads/"):
            filename = os.path.join(os.path.dirname(__file__), os.path.basename(path))
            if os.path.isfile(filename):
                with open(filename, mode="rb") as file:
                    content = file.read()

                self.send_response(200, "Success")
                self.send_header("Content-Length", len(content))
                if path.endswith(".xpi"):
                    self.send_header("Content-Type", "application/x-xpinstall")
                if path.endswith(".mar"):
                    self.send_header("Content-Type", "application/octet-stream")
                self.end_headers()

                # Make MAR download slow so tests can have time to show progress
                if path.endswith(".mar"):
                    chunk_size = int(len(content) / 10)
                    print(f"Total size {len(content)} => {chunk_size}")
                    for i in range(0, len(content), chunk_size):
                        print(f"Sending {chunk_size}")
                        chunk = content[i : i + chunk_size]
                        self.wfile.write(chunk)
                        self.wfile.flush()
                        time.sleep(1)
                else:
                    self.wfile.write(bytes(content))
            return

        if m is not None:
            self.reply(m, contentType=contentType)
        else:
            self.not_found(path)

    def do_POST(self):
        print("POST", self.path)
        m = None

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        print("path: ", path)
        if path == "/sso/token":
            payload = self.rfile.read(int(self.headers.get("Content-Length"))).decode(
                "utf-8"
            )
            parsed_payload = json.loads(payload)

            if parsed_payload["grant_type"] != "refresh_token":
                self.reply("", 401, "Authorization required")
                return

            if (
                parsed_payload["refresh_token"]
                != self.server.policy_refresh_token.value
            ):
                self.reply("", 401, "Authorization required")
                return

            self.server.policy_access_token.value = str(uuid.uuid4())
            self.server.policy_refresh_token.value = str(uuid.uuid4())
            print(
                f"Refreshed tokens: ({self.server.policy_access_token.value}, {self.server.policy_refresh_token.value})"
            )

            # Sending back the same session
            m = json.dumps({
                "access_token": self.server.policy_access_token.value,
                "token_type": "Bearer",
                "expires_in": 71999,
                "refresh_token": self.server.policy_refresh_token.value,
            })

        elif path == "/sso/device_posture":
            payload = json.loads(
                self.rfile.read(int(self.headers.get("Content-Length")))
            )
            self.server.device_posture_payload = payload
            if not hasattr(self.server, "device_posture_history"):
                self.server.device_posture_history = []
            self.server.device_posture_history.append(payload)
            self.server.device_posture_token = str(uuid.uuid4())
            m = json.dumps({"posture": self.server.device_posture_token})

        elif path == "/api/browser/policies":
            if not self.check_auth():
                return
            payload = json.loads(
                self.rfile.read(int(self.headers.get("Content-Length")))
            )
            self.server.device_posture_payload = payload
            if not hasattr(self.server, "device_posture_history"):
                self.server.device_posture_history = []
            self.server.device_posture_history.append(payload)
            if self.server.policies_fail_request.value:
                self.reply("", 500, "Internal Server Error", "application/json")
                return
            m = self.build_policies_response()

        elif path == "/sso/logout":
            if not self.check_auth():
                return
            with self.server.signout_count.get_lock():
                self.server.signout_count.value += 1
            self.server.policy_access_token.value = ""
            self.server.policy_refresh_token.value = ""
            m = json.dumps(None)

        elif path == "/api/browser/forced_updates_count":
            """
            This is a test only endpoint to reset how many updates were served
            """

            self.server.serve_forced_updates_count = 0
            m = json.dumps(None)

        elif path.startswith("/api/browser/updates"):
            self.server.serve_updates = not self.server.serve_updates
            payload = self.rfile.read(int(self.headers.get("Content-Length"))).decode(
                "utf-8"
            )
            self.server.serve_updates_version = urllib.parse.parse_qs(payload)
            print(
                f"Server Updates: {self.server.serve_updates} => {self.server.serve_updates_version}"
            )
            # Reply something so that we get 200
            m = json.dumps(None)

        if m is not None:
            self.reply(m, contentType="application/json")
        else:
            self.not_found(path)

    def do_HEAD(self):
        print("HEAD", self.path)

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("/downloads/"):
            filename = os.path.join(os.path.dirname(__file__), os.path.basename(path))
            if os.path.isfile(filename):
                self.send_response(200, "Success")
                self.send_header("Content-Length", os.stat(filename).st_size)
                if path.endswith(".xpi"):
                    self.send_header("Content-Type", "application/x-xpinstall")
                if path.endswith(".mar"):
                    self.send_header("Content-Type", "application/octet-stream")
                self.end_headers()
                return

        self.not_found(path)


def serve(
    classname,
    sso_port,
    console_port,
    is_console,
    cookie_name=None,
    cookie_value=None,
    login_location=None,
    policy_block_about_config=None,
    policy_extensions=None,
    policy_access_token=None,
    policy_refresh_token=None,
    policy_access_connector=None,
    policies_fail_request=None,
    key_fail_request=None,
    signout_count=None,
    # TODO: Behavior is not yet clearly defined
    # device_posture_reply_forbidden=None,
):
    httpd = ConsoleSSOHTTPServer(("", 0), classname)
    if is_console:
        console_port.value = httpd.server_address[1]
    else:
        sso_port.value = httpd.server_address[1]
    # There's a getter on the Mixin for these
    httpd._sso_port = sso_port
    httpd._console_port = console_port
    if cookie_name is not None:
        httpd.cookie_name = cookie_name
    if cookie_value is not None:
        httpd.cookie_value = cookie_value
    if login_location is not None:
        httpd.login_location = login_location
    if policy_block_about_config is not None:
        httpd.policy_block_about_config = policy_block_about_config
    if policy_extensions is not None:
        httpd.policy_extensions = policy_extensions
    if policy_access_token:
        httpd.policy_access_token = policy_access_token
    if policy_access_connector:
        httpd.policy_access_connector = policy_access_connector
    if policy_refresh_token:
        httpd.policy_refresh_token = policy_refresh_token
    httpd.policies_fail_request = (
        policies_fail_request if policies_fail_request is not None else Value("B", 0)
    )
    httpd.key_fail_request = (
        key_fail_request if key_fail_request is not None else Value("B", 0)
    )
    httpd.signout_count = signout_count if signout_count is not None else Value("i", 0)
    httpd.serve_updates = False
    httpd.serve_updates_version = ""
    httpd.serve_forced_updates_count = 0
    """
    TODO: Behavior is not yet clearly defined
    if device_posture_reply_forbidden is not None:
        httpd.device_posture_reply_forbidden = device_posture_reply_forbidden
    """
    print(
        f"Serving localhost:{httpd.server_address[1]} SSO={httpd.sso_port} CONSOLE={httpd.console_port} with {classname}"
    )
    httpd.serve_forever()
    print(
        f"Stopped serving localhost:{httpd.server_address[1]} SSO={httpd.sso_port} CONSOLE={httpd.console_port} with {classname}"
    )


class FeltLogoutChecker:
    """Context manager that asserts a FELT-managed Firefox browser logout of a specific type occurred.

    Must be instantiated while the FELT window is open (i.e. in setup()), since it
    registers a "felt-firefox-logout" observer in the FELT window via execute_script at
    construction time. Use assert_browser_logouts_with() to set the expected logout type,
    then wrap the action that triggers the logout in a with block.
    """

    def __init__(self, test):
        self._test = test
        self._expected_type = None
        self._saved_window_handle = None

        with test._driver.using_context("chrome"):
            test._driver.execute_script(
                """
                Services.prefs.clearUserPref("enterprise._test.logout_type");
                Services.obs.addObserver({
                    observe(subject, topic, data) {
                        Services.prefs.setStringPref("enterprise._test.logout_type", data);
                    }
                }, "felt-firefox-logout", false);
                """
            )

    def assert_browser_logouts_with(self, expected_type):
        self._expected_type = expected_type
        return self

    def __enter__(self):
        try:
            self._saved_window_handle = self._test._driver.current_chrome_window_handle
        except Exception:
            # If the parent browser window was closed, there is nothing to restore.
            self._saved_window_handle = None
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is not None:
            return False

        handles = self._test._wait.until(
            lambda mn: self._test._driver.chrome_window_handles
        )
        # switch_to_window resets Marionette's internal curBrowser pointer to the new
        # window; without it, execute_script would throw "browsing context has been
        # discarded" because it still references the old closed window.
        self._test._driver.switch_to_window(handles[0])
        with self._test._driver.using_context("chrome"):
            logout_type = self._test._wait.until(
                lambda mn: mn.execute_script(
                    'return Services.prefs.getStringPref("enterprise._test.logout_type", "") || null;'
                )
            )
        assert logout_type == self._expected_type, (
            f"Unexpected logout type: {logout_type}"
        )

        try:
            parent_handles = self._test._driver.chrome_window_handles
            if self._saved_window_handle in parent_handles:
                self._test._driver.switch_to_window(self._saved_window_handle)
        except Exception:
            # If the parent browser window was closed, there is nothing to restore.
            pass

        return False


def find_free_port():
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FeltTestsBase(ConsoleSSOPortMixin, EnterpriseTestsBase):
    EXTRA_ENV = {}

    def setUp(self):
        # test_prefs = kwargs.get("test_prefs", [])

        self._manually_closed_child = False
        # Private; use console_port and sso_port properties from ConsoleSSOPortMixin instead
        self._console_port = Value("i", 0)
        self._sso_port = Value("i", 0)
        self.login_location = SharedString("")
        self.policy_block_about_config = Value("b", 1)
        self.policy_access_connector = Value("b", 0)
        self.policy_extensions = Value("B", 0)
        self.policies_fail_request = Value("B", 0)
        self.key_fail_request = Value("B", 0)
        """
        TODO: Behavior is not yet clearly defined
        self.device_posture_reply_forbidden = Value("B", 0)
        """

        self.policy_access_token = SharedString("")
        self.policy_refresh_token = SharedString("")
        self.signout_count = Value("i", 0)

        self.console_httpd = Process(
            target=serve,
            args=(ConsoleHttpHandler,),
            kwargs=dict(
                sso_port=self._sso_port,
                console_port=self._console_port,
                is_console=True,
                login_location=self.login_location,
                policy_block_about_config=self.policy_block_about_config,
                policy_extensions=self.policy_extensions,
                policy_access_token=self.policy_access_token,
                policy_access_connector=self.policy_access_connector,
                policy_refresh_token=self.policy_refresh_token,
                policies_fail_request=self.policies_fail_request,
                key_fail_request=self.key_fail_request,
                signout_count=self.signout_count,
                # TODO: Behavior is not yet clearly defined
                # device_posture_reply_forbidden=self.device_posture_reply_forbidden,
            ),
        )
        self.console_httpd.start()

        self.cookie_name = SharedString(str(uuid.uuid1()).split("-")[0])
        self.cookie_value = SharedString(str(uuid.uuid4()).split("-")[4])
        self.sso_httpd = Process(
            target=serve,
            args=(SsoHttpHandler,),
            kwargs=dict(
                sso_port=self._sso_port,
                console_port=self._console_port,
                is_console=False,
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

    def _apply_prefs_for_instance(self):
        self._extra_prefs = {
            "enterprise.is_testing": True,
            "enterprise.log_level": "Debug",
        }  # + test_prefs

        if hasattr(self, "EXTRA_PREFS"):
            self._extra_prefs.update(self.EXTRA_PREFS)

        marionette = self._marionette_weakref()
        marionette.instance.profile.set_preferences(self._extra_prefs)

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
        self._apply_marionette_and_local_prefs_to_child_profile()

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
            pid = self._child_driver.session_capabilities["moz:processID"]
            self._child_driver.execute_script(
                "Services.startup.quit(Ci.nsIAppStartup.eForceQuit);"
            )
            self.wait_process_exit(pid)
            self._logger.info("Closed browser")
        else:
            self._logger.info("Browser was already manually closed.")

        self._logger.info("Shutting down console")
        self.console_httpd.terminate()
        self.console_httpd.join(timeout=5)
        if self.console_httpd.is_alive():
            self._logger.warning(
                "Console process did not exit after terminate; sending SIGKILL"
            )
            self.console_httpd.kill()
            self.console_httpd.join(timeout=2)
        self._logger.info("Shutting down SSO")
        self.sso_httpd.terminate()
        self.sso_httpd.join(timeout=5)
        if self.sso_httpd.is_alive():
            self._logger.warning(
                "SSO process did not exit after terminate; sending SIGKILL"
            )
            self.sso_httpd.kill()
            self.sso_httpd.join(timeout=2)
        self._logger.info("All stopped")

        # If the test never started a child browser, this would not exists
        if hasattr(self, "_child_profile_path"):
            self._logger.info(f"Removing browser profile at {self._child_profile_path}")
            shutil.rmtree(self._child_profile_path, ignore_errors=True)

    def _apply_marionette_and_local_prefs_to_child_profile(self):
        prefs = {
            k: v
            for k, v in {
                **GeckoInstance.required_prefs,
                **DesktopInstance.desktop_prefs,
            }.items()
            # Drop prefs with %-style format placeholders (e.g. "%(server)s")
            # as they require interpolation that isn't performed here.
            if not isinstance(v, str) or "%" not in v
        }
        prefs.update({"enterprise.is_testing": True, "enterprise.log_level": "Debug"})
        if hasattr(self, "EXTRA_CHILD_PREFS"):
            prefs.update(self.EXTRA_CHILD_PREFS)
        Preferences.write(os.path.join(self._child_profile_path, "user.js"), prefs)

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

    def find_elem(self, e):
        return self._driver.find_element(By.CSS_SELECTOR, e)

    def find_elem_by_id(self, e):
        return self._driver.find_element(By.ID, e)

    def find_elem_child(self, e):
        return self._child_driver.find_element(By.CSS_SELECTOR, e)

    def wait_process_exit(self, pid_to_check):
        self._logger.info(f"Checking PID {pid_to_check}")
        import psutil

        # Wait for a process termination
        continue_checking = True
        iterations = 0
        while continue_checking and psutil.pid_exists(pid_to_check) and iterations < 30:
            iterations += 1
            self._logger.info(f"PID {pid_to_check} still exists")

            try:
                process = psutil.Process(pid=pid_to_check)
                process_status = process.status()
                self._logger.info(f"Found PID {pid_to_check}: STATUS:{process_status}")
                continue_checking = process_status not in [
                    psutil.STATUS_STOPPED,
                    psutil.STATUS_ZOMBIE,
                    psutil.STATUS_DEAD,
                ]
            except psutil.NoSuchProcess:
                continue_checking = False
            except psutil.ZombieProcess:
                continue_checking = False

            time.sleep(1)

        self._logger.info(
            f"Active waiting for PID {pid_to_check} DONE => continue_checking:{continue_checking} iterations:{iterations} psutil.pid_exists(pid_to_check):{psutil.pid_exists(pid_to_check)}"
        )

        if psutil.pid_exists(pid_to_check):
            # Process is still not terminated, try to verify if it is still the same
            # or if the PID was re-used.
            try:
                process = psutil.Process(pid=pid_to_check)
                process_status = process.status()
                process_name = process.name()
                process_exe = process.exe()
                process_basename = os.path.basename(process_name)
                process_cmdline = process.cmdline()
                self._logger.info(
                    f"Found PID {pid_to_check}: STATUS:{process_status} :: EXE:{process_exe} :: NAME:{process_name} :: CMDLINE:{process_cmdline} :: BASENAME:'{process_basename}'"
                )
                # If process basename is not Firefox, then it is just PID re-use
                assert not process_basename.startswith("firefox"), (
                    f"Process PID {pid_to_check} should not be Firefox"
                )
            except psutil.NoSuchProcess:
                self._logger.info(f"PID disappeared {pid_to_check}")
            except psutil.ZombieProcess:
                # If it is a zombie, it is fine as well
                self._logger.info(f"Zombie found as {pid_to_check}")

        self._logger.info(f"All done for PID {pid_to_check}")

    def run_felt_base(self):
        self.run_felt_chrome_on_email_submit()
        self.run_wait_until_sso_loaded()
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

    def force_window(self):
        self._driver.set_context("chrome")
        assert len(self._driver.chrome_window_handles) == 1, "One window exists"
        self._driver.switch_to_window(self._driver.chrome_window_handles[0])
        self._driver.set_context("content")

    def maybe_save_screenshot(
        self, env, identifier, element=None, full=True, scroll=True
    ):
        if "UX_SCREENSHOT" in os.environ.keys():
            # UPLOAD_DIR is defined on TaskCluster, use it to write at the correct place
            with open(
                os.path.join(
                    os.environ.get("UPLOAD_DIR", ""), f"screenshot_{identifier}.png"
                ),
                "wb",
            ) as fh:
                self.get_driver(env).save_screenshot(
                    fh, element=element, full=full, scroll=scroll
                )


class FeltTests(FeltTestsBase):
    def reload_chrome_window(self):
        # We set a marker before reloading so we can reliably detect when the
        # new page is ready. A simple readyState == "complete" check is not
        # sufficient because the old page may still report "complete" for a
        # brief window after window.location.reload() is called, causing a
        # false positive. The marker is absent on the new page, so we can
        # unambiguously tell old page (marker matches), mid-reload (exception),
        # and new page loading (marker gone, readyState != "complete") apart.
        marker = str(uuid.uuid4())
        with self._driver.using_context(self._driver.CONTEXT_CHROME):
            try:
                self._driver.execute_script(
                    """
                    window.__felt_reload_marker = arguments[0];
                    window.location.reload();
                    """,
                    [marker],
                )
            except Exception:
                pass

            def new_page_loaded(_):
                try:
                    current = self._driver.execute_script(
                        "return window.__felt_reload_marker;"
                    )
                    if current == marker:
                        return False
                    return (
                        self._driver.execute_script("return document.readyState")
                        == "complete"
                    )
                except Exception:
                    return False

            self._wait.until(new_page_loaded)

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

    def run_wait_until_sso_loaded(self):
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

    @contextmanager
    def expect_new_felt_auth_window(self):
        """Context manager: assert FELT's auth window is replaced by a new one.

        Captures the current FELT chrome window handle on entry. On normal
        exit, waits for that window to be replaced by a new single chrome
        window and switches to it via force_window(). Use to wrap actions
        whose effect is that FELT closes its auth window and then re-opens
        a new one (e.g. login completion that spawns a child Firefox which
        then fails, causing FELT to re-open its auth window). Ensures the
        test awaits the new FELT window and not the original one prior to
        closing.
        """
        handles = self._driver.chrome_window_handles
        previous_handle = handles[0] if len(handles) == 1 else None
        yield

        def replaced(_):
            handles = self._driver.chrome_window_handles
            return previous_handle not in handles and len(handles) == 1

        self._wait.until(replaced)
        self.force_window()
