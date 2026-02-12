#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.


import os
import tempfile
import time
from copy import deepcopy

from marionette_driver.marionette import Marionette
from marionette_driver.wait import Wait
from marionette_harness import MarionetteTestCase


class EnterpriseTestsBase(MarionetteTestCase):
    def setUp(self):
        os.environ.update({"MOZ_DISABLE_NONLOCAL_CONNECTIONS": "0"})

        if hasattr(self, "EXTRA_ENV"):
            self._saved_env = deepcopy(os.environ)
            os.environ.update(self.EXTRA_ENV)

        self._logger = self.logger

        super().setUp()

        if hasattr(self, "_extra_cli_args"):
            self._saved_cli_args = deepcopy(self.marionette.instance.app_args)
            self.marionette.instance.app_args += self._extra_cli_args

        self.marionette.quit(in_app=False, clean=True)
        self.marionette.start_session()

        if hasattr(self, "_extra_prefs"):
            self.marionette.enforce_gecko_prefs(self._extra_prefs)

        self._driver = self.marionette

        if hasattr(self, "setup"):
            self.setup()

    def tearDown(self):
        super().tearDown()

        if hasattr(self, "teardown"):
            self.teardown()

        if hasattr(self, "_saved_env"):
            os.environ = deepcopy(self._saved_env)
            del self._saved_env

        if hasattr(self, "_saved_cli_args"):
            self.marionette.instance.app_args = deepcopy(self._saved_cli_args)
            del self._saved_cli_args

        del os.environ["MOZ_DISABLE_NONLOCAL_CONNECTIONS"]

        self.marionette.quit(in_app=False, clean=True)

    def get_profile_path(self, name):
        return tempfile.mkdtemp(
            prefix=name,
            dir=os.path.expanduser(self._profile_root),
        )

    @property
    def _wait(self):
        return self._waiter(self._driver)

    @property
    def _longwait(self):
        return self._longwaiter(self._driver)

    @property
    def _child_wait(self):
        return self._waiter(self._child_driver)

    @property
    def _child_longwait(self):
        return self._longwaiter(self._child_driver)

    def _waiter(self, driver):
        return Wait(driver, 10)

    def _longwaiter(self, driver):
        return Wait(driver, 60)

    def _open_tab(self, url, driver):
        handle = driver.open(type="tab")
        driver.switch_to_window(handle["handle"])
        driver.navigate(url)
        return handle

    def open_tab(self, url):
        return self._open_tab(url, self._driver)

    def open_tab_child(self, url):
        return self._open_tab(url, self._child_driver)

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

        new_marionette_port = 0
        with open(marionette_port_file) as infile:
            new_marionette_port = int(infile.read())

        self._logger.info(f"Marionette PORT NEW: {new_marionette_port}")
        assert marionette_port == new_marionette_port, "STILL Valid marionette port"
        assert marionette_port != 2828, "Marionette port should not be default value"

        self._child_driver = Marionette(host="127.0.0.1", port=new_marionette_port)
        self._child_driver.start_session(capabilities)
