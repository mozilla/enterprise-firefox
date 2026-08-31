#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.


import os
import shutil
import sys
import tempfile
import time
from copy import deepcopy
from enum import Enum

from marionette_driver import errors
from marionette_driver.marionette import Marionette
from marionette_driver.wait import Wait
from marionette_harness import MarionetteTestCase

# Byte shift applied to AutoConfig files. Must match the value locked by
# general.config.obscure_value in browser/branding/enterprise.
AUTOCONFIG_OBSCURE_VALUE = 13


def encode_autoconfig(text):
    """Byte shift AutoConfig source the way the browser expects to read it."""
    return bytes((b + AUTOCONFIG_OBSCURE_VALUE) & 0xFF for b in text.encode("utf-8"))


def decode_autoconfig(data):
    """Undo encode_autoconfig()."""
    return bytes((b - AUTOCONFIG_OBSCURE_VALUE) & 0xFF for b in data).decode("utf-8")


def patch_process_runner_args(instance):
    # It looks like on windows we are hitting bug 1906191, even after
    # all processes exit, the pipe write end may not close, causing mozprocess's
    # reader thread to block indefinitely on readline(). ignore_children makes
    # mozprocess skip joining the reader thread, allowing shutdown to proceed.
    original = instance._get_runner_args

    def _patched():
        args = original()
        # ignore_children is only supported by mozprocess (not the macOS psutil-based handler)
        if not sys.platform.startswith("darwin"):
            args["process_args"]["ignore_children"] = True
        return args

    def unpatch():
        instance._get_runner_args = original

    instance._get_runner_args = _patched
    return unpatch


class Environment(Enum):
    FELT = "felt"
    FIREFOX = "Firefox"


class EnterpriseTestsBase(MarionetteTestCase):
    def setUp(self):
        os.environ.update({"MOZ_DISABLE_NONLOCAL_CONNECTIONS": "0"})

        if getattr(self, "EXTRA_ENV", None):
            self._saved_env = deepcopy(os.environ)
            os.environ.update(self.EXTRA_ENV)

        self._logger = self.logger

        marionette = self._marionette_weakref()

        if hasattr(self, "_extra_cli_args"):
            self._saved_cli_args = deepcopy(marionette.instance.app_args)
            marionette.instance.app_args += self._extra_cli_args

        self._unpatch_process_runner_args = patch_process_runner_args(
            marionette.instance
        )

        # On the first test the harness has Firefox already running, so we stop
        # it here. On subsequent tests tearDown already quit it, so this
        # will only discard and recreate the profile.
        marionette.instance.close(clean=True)

        if hasattr(self, "_apply_prefs_for_instance"):
            self._apply_prefs_for_instance()

        # All this needs to happen before process is started to avoid race
        # conditions, but requires self.marionette that is setup by
        # super().setUp() right above.
        self.overwrite_autoconfig(marionette)

        super().setUp()

        if getattr(self, "_extra_prefs", None):
            self._logger.info("Marionette enforcing gecko prefs")
            self.marionette.enforce_gecko_prefs(self._extra_prefs)

        self._logger.info("Marionette ready")
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

        self._unpatch_process_runner_args()

        # If there were prefs forced during setUp(), marionette's geckoinstance
        # does cache them and on the next execution of enforce_gecko_pref(), if
        # those prefs are not there anymore in self._extra_prefs, marionette code
        # will fail to detect that prefs have changed, and not properly update
        # the profile, resulting in prefs leaking between tests
        if hasattr(self, "_extra_prefs"):
            self.marionette.instance.prefs = None

        del os.environ["MOZ_DISABLE_NONLOCAL_CONNECTIONS"]

        self.marionette.quit(in_app=False, clean=True)

        self.restore_autoconfig()

    def overwrite_autoconfig(self, marionette):
        # Some tests may need the shipped AutoConfig file, so respect it and do
        # not overwrite it when requested.
        # Also some tests may not define a console port, so skip this for them.
        if hasattr(self, "console_port") and not hasattr(self, "KEEP_AUTOCONFIG"):
            self.autoconfig_path = self.get_autoconfig(marionette)
            self.autoconfig_orig_path = f"{self.autoconfig_path}.orig"
            assert os.path.isfile(self.autoconfig_path)
            self._logger.info(
                f"Backup {self.autoconfig_path} as {self.autoconfig_orig_path}"
            )
            shutil.copy(self.autoconfig_path, self.autoconfig_orig_path)

            self._logger.info(f"Writing console pref in {self.autoconfig_path}")
            # The first line of an AutoConfig file is always skipped by the
            # parser, so the comment is required rather than decorative.
            #
            # defaultPref, not lockPref as the shipped firefox.cfg uses: tests
            # such as test_felt_console_error.py override the console address
            # with using_prefs() to point at error-inducing hosts, and a locked
            # pref cannot be overridden.
            with open(self.autoconfig_path, "wb") as cfg:
                cfg.write(
                    encode_autoconfig(
                        "// Test specific AutoConfig file\n"
                        'defaultPref("enterprise.console.address", '
                        f'"http://localhost:{self.console_port}");\n'
                    )
                )

    def restore_autoconfig(self):
        if hasattr(self, "console_port") and not hasattr(self, "KEEP_AUTOCONFIG"):
            if os.path.isfile(self.autoconfig_path):
                os.unlink(self.autoconfig_path)

            if os.path.isfile(self.autoconfig_orig_path):
                shutil.copy(self.autoconfig_orig_path, self.autoconfig_path)
                os.unlink(self.autoconfig_orig_path)

    def get_gre_dir(self, driver):
        # AutoConfig files are read from the GRE directory, which is alongside
        # the binary except on macOS where it is Contents/Resources.
        if sys.platform == "darwin":
            return os.path.join(
                os.path.dirname(os.path.dirname(driver.instance.binary)),
                "Resources",
            )

        return os.path.dirname(driver.instance.binary)

    def get_autoconfig(self, driver):
        app_name = os.path.basename(driver.instance.binary)
        cfg = os.path.join(self.get_gre_dir(driver), f"{app_name}.cfg")
        if not os.path.isfile(cfg):
            raise ValueError(f"Missing {cfg}")

        return cfg

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

    def get_marionette_port(self, max_try):
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

    def connect_child_browser(self, capabilities=None, max_try=100):
        (marionette_port, marionette_port_file) = self.get_marionette_port(
            max_try=max_try
        )
        assert marionette_port > 0, "Valid marionette port"
        self._logger.info(f"Marionette PORT: {marionette_port}")

        new_marionette_port = 0
        with open(marionette_port_file) as infile:
            new_marionette_port = int(infile.read())

        self._logger.info(f"Marionette PORT NEW: {new_marionette_port}")
        assert marionette_port == new_marionette_port, "STILL Valid marionette port"
        assert marionette_port != 2828, "Marionette port should not be default value"
        self._logger.info(f"Marionette PORT NEW: {new_marionette_port} OK")

        self._logger.info(f"New Marionette port={new_marionette_port}")
        self._child_driver = Marionette(host="127.0.0.1", port=new_marionette_port)
        self._logger.info(f"New Marionette port={new_marionette_port} OK")
        self._child_driver.start_session(capabilities, timeout=60)
        self._logger.info(f"New Marionette port={new_marionette_port} OK SESSION")

        port_file_copy = f"{marionette_port_file}.bak"
        self._logger.info(
            f"New Marionette port={new_marionette_port} MOVE OUT {marionette_port_file}"
        )
        if os.path.isfile(port_file_copy):
            os.unlink(port_file_copy)
        os.rename(marionette_port_file, port_file_copy)
        self._logger.info(
            f"New Marionette MOVED OUT {marionette_port_file} TO {port_file_copy}"
        )

    def get_driver(self, env):
        return self._driver if env == Environment.FELT else self._child_driver

    def get_logged_in_user_info(self, env):
        self._logger.info(f"Getting logged in user info in {env.name}.")

        driver = self.get_driver(env)

        driver.set_context("chrome")
        try:
            user = driver.execute_async_script(
                """
                const callback = arguments[arguments.length - 1];
                const { ConsoleClient } = ChromeUtils.importESModule("resource://gre/modules/enterprise/ConsoleClient.sys.mjs");
                ConsoleClient.getLoggedInUserInfo()
                    .then(callback)
                    .catch(err => callback({_error: String(err)}))
                """,
            )
            return user
        finally:
            driver.set_context("content")

    def assert_user_signed_in(self, env):
        self._logger.info(f"Verifying user is signed in in {env.name}.")

        user = self.get_logged_in_user_info(env)

        assert user["id"], "Expected user to exist"
        assert user["email"], "Expected user email to exist"

    def assert_user_signed_out(self, env):
        self._logger.info(f"Verifying user is signed out in {env.name}.")

        result = self.get_logged_in_user_info(env)
        assert (
            result["_error"]
            == "Error: Felt authentication flow has completed, but no valid token is available."
        ), "Unexpected state after signout"

    def assert_child_browser_closed(self):
        self._logger.info("Verifying child browser is closed.")
        try:
            self._child_driver.get_url()
            assert False, "Expected child browser to be closed"
        except (
            errors.InvalidSessionIdException,
            errors.NoSuchWindowException,
            errors.TimeoutException,
            OSError,
        ):
            pass
