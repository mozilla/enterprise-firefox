#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import datetime
import os
import random
import shutil
import sys
import tempfile
import time
import urllib.parse
import uuid
from multiprocessing import Process, Value

import requests
from base_test import EnterpriseTestsBase
from enterprise_server import (
    EnterpriseConsoleServer,
    LocalHttpRequestHandler,
    SharedString,
    serve,
)
from felt_consts import firefox_config
from marionette_driver import expected
from marionette_driver.by import By


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


class FeltTestsBase(EnterpriseTestsBase):
    EXTRA_ENV = {}

    def setUp(self):
        # test_prefs = kwargs.get("test_prefs", [])

        self._manually_closed_child = False
        self.console_port = random.randrange(10000, 14999)
        self.sso_port = random.randrange(15000, 20000)
        self.policy_block_about_config = Value("b", 1)
        self.policy_extensions = Value("B", 0)
        self.policies_fail_request = Value("B", 0)
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

        self.policy_access_token = SharedString("")
        self.policy_refresh_token = SharedString("")
        self.signout_count = Value("i", 0)

        browser_config = {
            "learn_more_url": firefox_config["learn_more_url"]["pref_value"],
            "company_logo_url": "",
            "policies": {"polling_frequency": 500},
            "services": {
                "push_url": "",
                "remote_settings_url": "",
                "tokenserver_url": "",
            },
            "extra_prefs": [["marionette.port", 0]],
        }
        self.console_httpd = EnterpriseConsoleServer(
            self.console_port,
            sso_port=self.sso_port,
            access_token=self.policy_access_token,
            refresh_token=self.policy_refresh_token,
            policy_block_about_config=self.policy_block_about_config,
            policy_extensions=self.policy_extensions,
            policies_fail_request=self.policies_fail_request,
            signout_count=self.signout_count,
            browser_config=browser_config,
            # TODO: Behavior is not yet clearly defined
            # device_posture_reply_forbidden=self.device_posture_reply_forbidden,
        )
        self.console_httpd.start(wait_for_ready=False)

        self.cookie_name = SharedString(str(uuid.uuid1()).split("-")[0])
        self.cookie_value = SharedString(str(uuid.uuid4()).split("-")[4])
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
        if not self.console_httpd.wait_until_ready():
            raise Exception(f"Console server not ready on port {self.console_port}")

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
        self.console_httpd.stop()
        self._logger.info("Shutting down SSO")
        requests.post(f"http://localhost:{self.sso_port}/:shutdown", timeout=2)
        self._logger.info("Stopping process SSO")
        self.sso_httpd.join()
        self._logger.info("All stopped")

        # If the test never started a child browser, this would not exists
        if hasattr(self, "_child_profile_path"):
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
