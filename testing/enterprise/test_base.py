#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.


import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import traceback

from mozlog import formatters, handlers, structuredlog
from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.remote.webelement import WebElement
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


class EnterpriseTestsBase:
    _INSTANCE = None

    def __init__(self, exp, firefox, geckodriver, profile_root):
        self._EXE_PATH = rf"{geckodriver}"
        self._BIN_PATH = rf"{firefox}"

        profile_path = tempfile.mkdtemp(
            prefix="enterprise-tests",
            dir=os.path.expanduser(profile_root),
        )

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

        options = Options()
        if "TEST_GECKODRIVER_TRACE" in os.environ.keys():
            options.log.level = "trace"
        options.binary_location = self._BIN_PATH
        if not "TEST_NO_HEADLESS" in os.environ.keys():
            options.add_argument("--headless")
        if "MOZ_AUTOMATION" in os.environ.keys():
            os.environ["MOZ_LOG_FILE"] = os.path.join(
                os.environ.get("ARTIFACT_DIR"), "gecko.log"
            )
        options.add_argument("-profile")
        options.add_argument(profile_path)
        self._driver = webdriver.Firefox(service=driver_service, options=options)

        self._logger = structuredlog.StructuredLogger(self.__class__.__name__)
        self._logger.add_handler(
            handlers.StreamHandler(sys.stdout, formatters.TbplFormatter())
        )

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

        self._driver.maximize_window()

        self._wait = WebDriverWait(self._driver, self.get_timeout())
        self._longwait = WebDriverWait(self._driver, 60)

        with open(exp) as j:
            self._expectations = json.load(j)

        # exit code ; will be set to 1 at first assertion failure
        ec = 0
        first_tab = self._driver.window_handles[0]
        channel = self.update_channel()
        self._logger.info(f"Channel: {channel}")

        for m in object_methods:
            tabs_before = set()
            tabs_after = set()
            self._logger.test_start(m)
            expectations = (
                self._expectations[m]
                if not channel in self._expectations[m]
                else self._expectations[m][channel]
            )
            self._driver.switch_to.window(first_tab)

            try:
                tabs_before = set(self._driver.window_handles)
                rv = getattr(self, m)(expectations)
                assert rv is not None, "test returned no value"

                tabs_after = set(self._driver.window_handles)
                self._logger.info(f"tabs_after OK {tabs_after}")

                self._driver.switch_to.parent_frame()
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
                self._driver.switch_to.parent_frame()
                self._logger.test_end(m, status=test_status, message=test_message)
                traceback.print_exc()

                tabs_after = set(self._driver.window_handles)
                self._logger.info(f"tabs_after EXCEPTION {tabs_after}")
            finally:
                self._logger.info(f"tabs_before {tabs_before}")
                tabs_opened = tabs_after - tabs_before
                self._logger.info(f"opened {len(tabs_opened)} tabs")
                self._logger.info(f"opened {tabs_opened} tabs")
                closed = 0
                for tab in tabs_opened:
                    self._logger.info(f"switch to {tab}")
                    self._driver.switch_to.window(tab)
                    self._logger.info(f"close {tab}")
                    self._driver.close()
                    closed += 1
                    self._logger.info(
                        f"wait EC.number_of_windows_to_be({len(tabs_after) - closed})"
                    )
                    self._wait.until(
                        EC.number_of_windows_to_be(len(tabs_after) - closed)
                    )

                self._driver.switch_to.window(first_tab)

        if not "TEST_NO_QUIT" in os.environ.keys():
            self._driver.quit()

        self._logger.info(f"Exiting with {ec}")
        self._logger.suite_end()
        sys.exit(ec)

    def get_timeout(self):
        if "TEST_TIMEOUT" in os.environ.keys():
            return int(os.getenv("TEST_TIMEOUT"))
        else:
            return 5

    def open_tab(self, url):
        opened_tabs = len(self._driver.window_handles)

        self._driver.switch_to.new_window("tab")
        self._wait.until(EC.number_of_windows_to_be(opened_tabs + 1))
        self._driver.get(url)

        return self._driver.current_window_handle

    def need_allow_system_access(self):
        geckodriver_output = subprocess.check_output(
            [self._EXE_PATH, "--help"]
        ).decode()
        return "--allow-system-access" in geckodriver_output

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
