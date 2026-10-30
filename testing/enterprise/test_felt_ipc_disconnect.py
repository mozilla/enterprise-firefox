#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ctypes
import os
import platform
import sys
from ctypes import wintypes

import psutil

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests
from marionette_driver.errors import NoSuchWindowException, UnknownException


class FeltIpcDisconnect(FeltTests):
    def setup(self):
        super().setup()
        self._manually_closed_child = True
        self._browser_process = None

    def teardown(self):
        try:
            if self._browser_process is not None:
                try:
                    self._browser_process.kill()
                    self._browser_process.wait(timeout=30)
                except psutil.NoSuchProcess:
                    pass
        finally:
            super().teardown()

    def _track_browser(self, pid):
        self._browser_process = psutil.Process(pid)
        return pid

    def _kill_felt_and_wait_for_browser_exit(self, app_pid, expect_error_dialog=False):
        parent_pid = self._driver.session_capabilities["moz:processID"]
        self._driver.delete_session(send_request=False)
        # Kill only FELT, so terminating its process tree cannot make the test pass.
        psutil.Process(parent_pid).kill()
        if expect_error_dialog and platform.system() == "Windows":
            # On Windows, Output() reports the error in a modal message box
            # that blocks exit until a user dismisses it, so check the message
            # and end the browser ourselves.
            self._assert_error_dialog(app_pid)
            self._browser_process.kill()
        self.wait_process_exit(app_pid)

    def _get_top_level_windows(self, app_pid):
        """Return (class, title, message, visible) for each top-level window
        owned by app_pid. message is a message box's body text."""
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        for name in ("GetClassNameW", "GetWindowTextW"):
            getattr(user32, name).argtypes = [
                wintypes.HWND,
                wintypes.LPWSTR,
                ctypes.c_int,
            ]
        user32.GetDlgItemTextW.argtypes = [
            wintypes.HWND,
            ctypes.c_int,
            wintypes.LPWSTR,
            ctypes.c_int,
        ]
        user32.GetWindowThreadProcessId.argtypes = [
            wintypes.HWND,
            ctypes.POINTER(wintypes.DWORD),
        ]
        user32.IsWindowVisible.argtypes = [wintypes.HWND]
        windows = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def collect(hwnd, _):
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value != app_pid:
                return True
            class_name = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, class_name, len(class_name))
            title = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, title, len(title))
            # Message boxes put their body text in a static control with this id.
            message = ctypes.create_unicode_buffer(1024)
            user32.GetDlgItemTextW(hwnd, 0xFFFF, message, len(message))
            windows.append((
                class_name.value,
                title.value,
                message.value,
                bool(user32.IsWindowVisible(hwnd)),
            ))
            return True

        user32.EnumWindows(collect, 0)
        return windows

    def _assert_error_dialog(self, app_pid):
        expected = "Error: Felt connection closed during startup."

        def has_error_dialog(_):
            return any(
                class_name == "#32770" and visible and message.strip() == expected
                for class_name, _, message, visible in self._get_top_level_windows(
                    app_pid
                )
            )

        try:
            self._wait.until(
                has_error_dialog,
                message=f"The browser should show a dialog reading {expected!r}",
            )
        except Exception:
            for class_name, title, message, visible in self._get_top_level_windows(
                app_pid
            ):
                self._logger.info(
                    f"PID {app_pid} window: class={class_name!r} title={title!r} "
                    f"message={message!r} visible={visible}"
                )
            raise

    def test_disconnect_after_startup(self):
        # Launches FELT with a stored session and waits until the browser is
        # connected over Marionette and signed in.
        app_pid = self._track_browser(self._start_signed_in())
        self._kill_felt_and_wait_for_browser_exit(app_pid)

    def test_disconnect_before_startup_ready(self):
        self._hold_felt_after_child_exit()
        self._prepare_felt_keystore()
        # Both wrappers call the real methods. _awaitAnnouncedBrowserPid records
        # the browser pid (proc.pid is the launcher on Windows).
        # sendPrefsToFirefox publishes that pid, then never resolves, so FELT
        # never sends Ready and the browser stays in its startup wait.
        with self._driver.using_context("chrome"):
            self._driver.execute_script(
                """
                const { FeltProcessParent } = ChromeUtils.importESModule(
                  "chrome://felt/content/FeltProcessParent.sys.mjs"
                );
                const prototype = FeltProcessParent.prototype;
                const awaitPid = prototype._awaitAnnouncedBrowserPid;
                prototype._awaitAnnouncedBrowserPid = async function(...args) {
                  this.testBrowserPid = await awaitPid.apply(this, args);
                  return this.testBrowserPid;
                };
                const sendPrefs = prototype.sendPrefsToFirefox;
                prototype.sendPrefsToFirefox = async function() {
                  await sendPrefs.call(this);
                  Services.prefs.setStringPref(
                    "enterprise.felt_tests.ipc_startup_app_pid",
                    String(this.testBrowserPid || this.proc.pid)
                  );
                  await new Promise(() => {});
                };
                """
            )

        self.run_felt_base()
        app_pid = self._longwait.until(
            lambda driver: driver.get_pref("enterprise.felt_tests.ipc_startup_app_pid"),
            message="FELT should pause browser startup before sending Ready",
        )
        app_pid = self._track_browser(int(app_pid))
        self.assertTrue(
            self._browser_process.is_running()
            and self._browser_process.status() != psutil.STATUS_ZOMBIE,
            "The browser should still be waiting for FELT's Ready message",
        )
        self._kill_felt_and_wait_for_browser_exit(app_pid, expect_error_dialog=True)

    def test_normal_shutdown_keeps_felt_alive(self):
        app_pid = self._track_browser(self._start_signed_in())
        with self._driver.using_context("chrome"):
            self._driver.execute_script(
                """
                const pref = "enterprise.felt_tests.ipc_exit_count";
                Services.prefs.setIntPref(pref, 0);
                Services.obs.addObserver(() => {
                  Services.prefs.setIntPref(pref, Services.prefs.getIntPref(pref) + 1);
                }, "felt-firefox-exiting");
                """
            )

        self._child_driver.set_context("chrome")
        try:
            self._child_driver.execute_script(
                "Services.startup.quit(Ci.nsIAppStartup.eForceQuit);"
            )
        except (OSError, NoSuchWindowException, UnknownException) as exc:
            self._logger.info(f"Browser quit before execute_script returned: {exc}")
        self._wait.until(
            lambda _: self.signout_count.value == 1,
            message="Normal shutdown should sign out rather than restart the browser",
        )
        self._settle_after_child_exit(app_pid)
        self.assertEqual(
            self._driver.get_pref("enterprise.felt_tests.ipc_exit_count"),
            1,
            "Normal shutdown should report exactly one browser exit to FELT",
        )
        self.assert_user_signed_out(env=Environment.FELT)
