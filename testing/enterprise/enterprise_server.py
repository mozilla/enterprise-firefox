# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ctypes
import datetime
import json
import os
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from multiprocessing import Array, Process, Value


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


class LocalHttpRequestHandler(BaseHTTPRequestHandler):
    """Base request handler with shared reply helpers and /:shutdown support."""

    def reply(self, payload, code=200, status="Success", contentType=None):
        """Send an HTTP response. payload must be a str."""
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


class ConsoleHttpHandler(LocalHttpRequestHandler):
    """HTTP handler implementing the mock enterprise console API, SSO redirect, and file download endpoints."""

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
            self.send_response(302, "Found")
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        elif path == "/api/browser/config":
            config = getattr(self.server, "browser_config", None) or {
                "learn_more_url": "",
                "company_logo_url": "",
                "policies": {"polling_frequency": 500},
                "services": {
                    "push_url": "",
                    "remote_settings_url": "",
                    "tokenserver_url": "",
                },
                "extra_prefs": [],
            }
            m = json.dumps(config)

        elif path == "/api/browser/policies":
            self.check_auth()
            if self.server.policies_fail_request.value:
                self.reply("", 500, "Internal Server Error", "application/json")
                return
            policy_content = {}

            policy_block_about_config = getattr(
                self.server, "policy_block_about_config", None
            )
            if (
                policy_block_about_config is not None
                and policy_block_about_config.value >= 0
            ):
                policy_content.update({
                    "BlockAboutConfig": policy_block_about_config.value == 1
                })

            policy_extensions = getattr(self.server, "policy_extensions", None)
            if policy_extensions is not None and policy_extensions.value == 1:
                policy_content.update({
                    "ExtensionSettings": {
                        "treestyletab@piro.sakura.ne.jp": {
                            "installation_mode": "force_installed",
                            "install_url": f"http://localhost:{self.server.console_port}/downloads/tree_style_tab-4.2.7.xpi",
                            "updates_disabled": True,
                        }
                    }
                })

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

        elif path == "/api/browser/forced_updates_count":
            m = json.dumps({
                "serve_forced_updates_count": getattr(
                    self.server, "serve_forced_updates_count", 0
                )
            })
            contentType = "application/json"

        elif path.startswith("/api/browser/updates"):
            serve_updates = getattr(self.server, "serve_updates", False)
            complete_mar = os.path.join(
                os.path.dirname(__file__), os.path.basename("complete.mar")
            )
            if serve_updates and os.path.isfile(complete_mar):
                serve_updates_version = self.server.serve_updates_version
                display_version = serve_updates_version["application_version"][0]
                app_version = serve_updates_version["application_version"][0]
                platform_version = serve_updates_version["platform_version"][0]
                build_id = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
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
                self.server.serve_forced_updates_count = (
                    getattr(self.server, "serve_forced_updates_count", 0) + 1
                )

            contentType = "text/xml"

        elif path == "/sso/callback":
            self.server.policy_access_token.value = str(uuid.uuid4())
            self.server.policy_refresh_token.value = str(uuid.uuid4())
            obj = json.dumps({
                "access_token": self.server.policy_access_token.value,
                "token_type": "bearer",
                "expires_in": 71999,
                "refresh_token": self.server.policy_refresh_token.value,
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

        elif path == "/sso/get_device_posture":
            m = json.dumps(getattr(self.server, "device_posture_payload", {}))
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
        m = super().do_POST()

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

            m = json.dumps({
                "access_token": self.server.policy_access_token.value,
                "token_type": "Bearer",
                "expires_in": 71999,
                "refresh_token": self.server.policy_refresh_token.value,
            })

        elif path == "/api/browser/account":
            self.check_auth()
            m = json.dumps({
                "uid": "test-uid",
                "email": "test@enterprise.test",
                "displayName": "Test User",
                "avatar": "",
            })

        elif path == "/sso/device_posture":
            self.server.device_posture_payload = json.loads(
                self.rfile.read(int(self.headers.get("Content-Length")))
            )
            self.server.device_posture_token = str(uuid.uuid4())
            m = json.dumps({"posture": self.server.device_posture_token})

        elif path == "/sso/logout":
            self.check_auth()
            with self.server.signout_count.get_lock():
                self.server.signout_count.value += 1
            self.server.policy_access_token.value = ""
            self.server.policy_refresh_token.value = ""
            m = json.dumps(None)

        elif path == "/api/browser/forced_updates_count":
            self.server.serve_forced_updates_count = 0
            m = json.dumps(None)

        elif path.startswith("/api/browser/updates"):
            self.server.serve_updates = not getattr(self.server, "serve_updates", False)
            payload = self.rfile.read(int(self.headers.get("Content-Length"))).decode(
                "utf-8"
            )
            self.server.serve_updates_version = urllib.parse.parse_qs(payload)
            print(
                f"Server Updates: {self.server.serve_updates} => {self.server.serve_updates_version}"
            )
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


def wait_until_ready(port, max_tries=20):
    """Poll /ping on localhost:port until it responds, trying up to max_tries times."""
    from urllib.request import urlopen

    for _ in range(max_tries):
        try:
            urlopen(f"http://localhost:{port}/ping", timeout=1)
            return True
        except Exception:
            time.sleep(0.5)
    return False


class EnterpriseConsoleServer:
    """Manages the lifecycle of a ConsoleHttpHandler server process."""

    def __init__(
        self, port, sso_port=0, access_token=None, refresh_token=None, **kwargs
    ):
        """
        access_token / refresh_token: SharedString instances shared with the caller for
        out-of-process reads. Defaults to freshly generated UUIDs if not provided.
        kwargs: forwarded to serve() and set as attributes on the HTTPServer instance.
        """
        self.port = port
        self.access_token = (
            access_token
            if access_token is not None
            else SharedString(str(uuid.uuid4()))
        )
        self.refresh_token = (
            refresh_token
            if refresh_token is not None
            else SharedString(str(uuid.uuid4()))
        )
        self._sso_port = sso_port
        self._kwargs = kwargs
        self._process = None

    def start(self, wait_for_ready=True):
        """Start the server process. If wait_for_ready is False, return immediately
        and call wait_until_ready() later once other setup is done."""
        self._process = Process(
            target=serve,
            args=(self.port, ConsoleHttpHandler),
            kwargs=dict(
                sso_port=self._sso_port,
                console_port=self.port,
                policy_access_token=self.access_token,
                policy_refresh_token=self.refresh_token,
                **self._kwargs,
            ),
            daemon=True,
        )
        self._process.start()
        if wait_for_ready and not wait_until_ready(self.port):
            self._process.terminate()
            self._process.join()
            self._process = None
            return False
        return True

    def wait_until_ready(self):
        return wait_until_ready(self.port)

    def configure(self, profile, browser_env):
        """Set the prefs and env vars that point the browser at this server.

        profile: mozprofile.Profile
        browser_env: dict of environment variables passed to the browser process
        """
        profile.set_preferences({
            "enterprise.console.address": f"http://localhost:{self.port}",
            "identity.fxaccounts.allowHttp": True,
        })
        browser_env["TEST_ENTERPRISE_ACCESS_TOKEN"] = self.access_token.value
        browser_env["TEST_ENTERPRISE_REFRESH_TOKEN"] = self.refresh_token.value

    def stop(self):
        if self._process is not None:
            try:
                import urllib.request

                req = urllib.request.Request(
                    f"http://localhost:{self.port}/:shutdown",
                    data=b"",
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=2)
            except Exception:
                pass
            self._process.join(timeout=5)
            if self._process.is_alive():
                self._process.terminate()
                self._process.join()
            self._process = None


def serve(
    port,
    classname,  # BaseHTTPRequestHandler subclass to instantiate
    sso_port,
    console_port,
    cookie_name=None,
    cookie_value=None,
    policy_block_about_config=None,
    policy_extensions=None,
    policy_access_token=None,
    policy_refresh_token=None,
    policies_fail_request=None,
    browser_config=None,
    signout_count=None,
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
    httpd.policies_fail_request = (
        policies_fail_request if policies_fail_request is not None else Value("B", 0)
    )
    httpd.signout_count = signout_count if signout_count is not None else Value("i", 0)
    httpd.serve_updates = False
    httpd.serve_updates_version = ""
    httpd.serve_forced_updates_count = 0
    httpd.device_posture_token = ""
    httpd.device_posture_payload = {}
    if browser_config is not None:
        httpd.browser_config = browser_config
    print(
        f"Serving localhost:{port} SSO={sso_port} CONSOLE={console_port} with {classname}"
    )
    httpd.serve_forever()
    print(
        f"Stopped serving localhost:{port} SSO={sso_port} CONSOLE={console_port} with {classname}"
    )
