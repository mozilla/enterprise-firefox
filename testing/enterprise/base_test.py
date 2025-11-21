#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.


import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

from mozlog import formatters, handlers, structuredlog
from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


class EnterpriseTestsBase:
    _INSTANCE = None

    def __init__(
        self,
        exp,
        firefox,
        geckodriver,
        profile_root,
        extra_cli_args=[],
        extra_env=[],
        extra_prefs=None,
        dont_maximize=False,
    ):
        self._EXE_PATH = rf"{geckodriver}"
        self._BIN_PATH = rf"{firefox}"

        self._profile_root = profile_root

        driver_service_args = []
        if self.need_allow_system_access():
            driver_service_args += ["--allow-system-access"]

        driver_service = Service(
            executable_path=self._EXE_PATH,
            log_output=os.path.join(
                os.environ.get("ARTIFACT_DIR", ""), "geckodriver.log"
            ),
            service_args=driver_service_args,
        )

        self._logger = structuredlog.StructuredLogger(self.__class__.__name__)
        self._logger.add_handler(
            handlers.StreamHandler(sys.stdout, formatters.TbplFormatter())
        )

        options = Options()
        if "TEST_GECKODRIVER_TRACE" in os.environ.keys():
            options.log.level = "trace"
        options.binary_location = self._BIN_PATH
        if not "TEST_NO_HEADLESS" in os.environ.keys():
            options.add_argument("--headless")
        if "MOZ_AUTOMATION" in os.environ.keys():
            os.environ["MOZ_LOG_FILE"] = os.path.join(
                os.environ.get("ARTIFACT_DIR", ""), "gecko.log"
            )

        profile_path = self.get_profile_path(name="enterprise-tests")
        options.add_argument("-profile")
        options.add_argument(profile_path)

        if extra_prefs:
            self._logger.info(f"Setting extra prefs at {profile_path}")
            with open(os.path.join(profile_path, "user.js"), "w") as user_pref:
                for pref in extra_prefs:
                    if type(pref[1]) is bool:
                        v = "true" if pref[1] else "false"
                        user_pref.write(f'user_pref("{pref[0]}", {v});\n')
                    elif type(pref[1]) is int:
                        user_pref.write(f'user_pref("{pref[0]}", {pref[1]});\n')
                    else:
                        user_pref.write(f'user_pref("{pref[0]}", "{pref[1]}");\n')

        for arg in extra_cli_args:
            options.add_argument(arg)

        os.environ.update({"MOZ_AUTOMATION": "1"})
        os.environ.update(extra_env)

        self._driver = webdriver.Firefox(service=driver_service, options=options)

        test_filter = "test_{}".format(os.environ.get("TEST_FILTER", ""))
        object_methods = [
            method_name
            for method_name in dir(self)
            if callable(getattr(self, method_name))
            and method_name.startswith(test_filter)
        ]

        self._logger.suite_start(object_methods)

        self._update_channel = None
        self._version_major = None

        if not dont_maximize:
            self._driver.maximize_window()

        self._wait = WebDriverWait(self._driver, self.get_timeout())
        self._longwait = WebDriverWait(self._driver, 60)

        this_dir = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(this_dir, exp)) as j:
            self._expectations = json.load(j)

        # exit code ; will be set to 1 at first assertion failure
        ec = 0
        channel = self.update_channel()
        self._logger.info(f"Channel: {channel}")

        self.setup()

        for m in object_methods:
            self._logger.info(f"Running method {m}")
            self._logger.test_start(m)
            expectations = (
                self._expectations[m]
                if not channel in self._expectations[m]
                else self._expectations[m][channel]
            )

            try:
                self._logger.info(f"Calling method {m}")
                rv = getattr(self, m)(expectations)
                assert rv is not None, "test returned no value"

                if rv:
                    self._logger.test_end(m, status="OK")
                else:
                    self._logger.test_end(m, status="FAIL")
            except Exception as ex:
                ec = 1
                test_status = "ERROR"
                if isinstance(ex, AssertionError):
                    test_status = "FAIL"
                elif isinstance(ex, TimeoutException):
                    test_status = "TIMEOUT"

                test_message = repr(ex)
                self.save_screenshot(
                    f"screenshot_{m.lower()}_{test_status.lower()}.png"
                )
                self.save_screenshot_child(
                    f"screenshot_{m.lower()}_{test_status.lower()}_childBrowser.png"
                )
                try:
                    self._driver.switch_to.parent_frame()
                    self.save_screenshot(
                        f"screenshot_{m.lower()}_{test_status.lower()}_parent.png"
                    )
                    self._child_driver.switch_to.parent_frame()
                    self.save_screenshot_child(
                        f"screenshot_{m.lower()}_{test_status.lower()}_parent_childBrowser.png"
                    )
                except Exception:
                    self._logger.info(
                        "Failed to switch to parent frame for screenshot."
                    )

                self._logger.test_end(m, status=test_status, message=test_message)
                traceback.print_exc()

        self.teardown()

        if not "TEST_NO_QUIT" in os.environ.keys():
            self._driver.quit()

        self._logger.info(f"Exiting with {ec}")
        self._logger.suite_end()

        ec = self.check_for_crashes(ec)

        shutil.rmtree(profile_path, ignore_errors=True)

        sys.exit(ec)

    def check_for_crashes(self, exit_code):
        for log_file in ["geckodriver.log", "geckodriver_child.log"]:
            if log_file != "geckodriver.log" and not os.path.isfile(log_file):
                # Only geckodriver.log is really required others can be missing
                continue

            with open(log_file) as log_content:
                for line in log_content:
                    if "MOZ_CRASH()" in line:
                        print("Crash reported at =>", line)
                        return 1

        return exit_code

    def get_screenshot_destination(self, name):
        final_name = name
        if "MOZ_AUTOMATION" in os.environ.keys():
            final_name = os.path.join(os.environ.get("ARTIFACT_DIR"), name)
        return final_name

    def save_screenshot(self, name):
        final_name = self.get_screenshot_destination(name)
        self._logger.info(f"Saving screenshot '{name}' to '{final_name}'")
        try:
            self._driver.save_screenshot(final_name)
        except WebDriverException as ex:
            self._logger.info(f"Saving screenshot FAILED due to {ex}")

    def save_screenshot_child(self, name):
        final_name = self.get_screenshot_destination(name)
        if not hasattr(self, "_child_driver"):
            self._logger.info(
                f"No child browser to save screenshot '{name}' to '{final_name}'"
            )
            return

        self._logger.info(f"Saving child browser screenshot '{name}' to '{final_name}'")
        try:
            self._child_driver.save_screenshot(final_name)
        except WebDriverException as ex:
            self._logger.info(f"Saving child browser screenshot FAILED due to {ex}")

    def get_timeout(self):
        if "TEST_TIMEOUT" in os.environ.keys():
            return int(os.getenv("TEST_TIMEOUT"))
        else:
            return 5

    def get_profile_path(self, name):
        return tempfile.mkdtemp(
            prefix=name,
            dir=os.path.expanduser(self._profile_root),
        )

    def _open_tab(self, url, driver, waiter):
        tabs = driver.window_handles
        driver.switch_to.new_window("tab")
        waiter.until(EC.new_window_is_opened(tabs))
        driver.get(url)
        return driver.current_window_handle

    def open_tab(self, url):
        return self._open_tab(url, self._driver, self._wait)

    def open_tab_child(self, url):
        return self._open_tab(url, self._child_driver, self._child_wait)

    def need_allow_system_access(self):
        geckodriver_output = subprocess.check_output(
            [self._EXE_PATH, "--help"]
        ).decode()
        return "--allow-system-access" in geckodriver_output

    def get_marionette_port(self, max_try=100):
        marionette_port_file = os.path.join(
            self._child_profile_path, "MarionetteActivePort"
        )

        found_marionette_port = False
        tries = 0
        while (not found_marionette_port) and (tries < max_try):
            tries += 1
            found_marionette_port = os.path.isfile(marionette_port_file)
            time.sleep(0.5)

        marionette_port = 0
        with open(marionette_port_file) as infile:
            marionette_port = int(infile.read())

        return (marionette_port, marionette_port_file)

    def connect_child_browser(self, capabilities=None):
        (marionette_port, marionette_port_file) = self.get_marionette_port()
        assert marionette_port > 0, "Valid marionette port"
        self._logger.info(f"Marionette PORT: {marionette_port}")

        driver_service_args = [
            "--allow-system-access",
            "--connect-existing",
            "--marionette-port",
            str(marionette_port),
        ]
        driver_service = Service(
            executable_path=self._EXE_PATH,
            log_output="geckodriver_child.log",
            service_args=driver_service_args,
        )

        options = Options()
        options.log.level = "trace"
        if capabilities:
            for k, v in capabilities.items():
                options.set_capability(k, v)

        new_marionette_port = 0
        with open(marionette_port_file) as infile:
            new_marionette_port = int(infile.read())

        self._logger.info(f"Marionette PORT NEW: {new_marionette_port}")
        assert marionette_port == new_marionette_port, "STILL Valid marionette port"
        assert marionette_port != 2828, "Marionette port should not be default value"

        self._child_driver = webdriver.Firefox(service=driver_service, options=options)
        self._child_wait = WebDriverWait(self._child_driver, self.get_timeout())
        self._child_longwait = WebDriverWait(self._child_driver, 60)

    def update_channel(self):
        if self._update_channel is None:
            self._driver.set_context("chrome")
            self._update_channel = self._driver.execute_script(
                "return Services.prefs.getStringPref('app.update.channel');"
            )
            self._logger.info(f"Update channel: {self._update_channel}")
            self._driver.set_context("content")
        return self._update_channel

    def version(self):
        self._driver.set_context("chrome")
        version = self._driver.execute_script("return AppConstants.MOZ_APP_VERSION;")
        self._driver.set_context("content")
        return version

    def version_major(self):
        if self._version_major is None:
            self._driver.set_context("chrome")
            self._version_major = self._driver.execute_script(
                "return AppConstants.MOZ_APP_VERSION.split('.')[0];"
            )
            self._logger.info(f"Version major: {self._version_major}")
            self._driver.set_context("content")
        return self._version_major
