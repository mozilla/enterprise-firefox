#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ctypes
import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_external_link import BaseBrowserExternalLink


class FeltBrowserExternalLinkFocus(BaseBrowserExternalLink):
    """Opening an external link while the browser runs must bring the
    browsing child's window to the foreground, not the Felt UI's hidden
    remoting window. Windows only: the assertion reads GetForegroundWindow()
    from the OS, which is the ground truth SetForegroundWindow acts on."""

    def test_external_link_raises_browser_window(self):
        self.run_felt_base()
        self._external_link = f"http://localhost:{self.console_port}/ping"
        self.run_felt_browser_started()

        hwnd = self.get_browser_hwnd()
        self._logger.info(f"Browser window hwnd={hwnd:#x}")

        self.minimize_browser_window()
        self._wait.until(
            lambda mn: self.get_foreground_hwnd() != hwnd,
            message="browser window still in the foreground after minimize",
        )
        self._logger.info(f"Foreground moved to hwnd={self.get_foreground_hwnd():#x}")

        self.grant_felt_ui_foreground_right()
        self.run_felt_open_external_link()

        self._wait.until(
            lambda mn: self.get_foreground_hwnd() == hwnd,
            message="external link did not bring the browser window to the foreground",
        )
        self._logger.info("Browser window is back in the foreground")

    def get_browser_hwnd(self):
        with self._child_driver.using_context("chrome"):
            handle = self._child_driver.execute_script(
                """
                return window.docShell.treeOwner
                  .QueryInterface(Ci.nsIBaseWindow).nativeHandle;
                """
            )
        return int(handle, 16)

    def minimize_browser_window(self):
        with self._child_driver.using_context("chrome"):
            self._child_driver.execute_script("window.minimize();")

    def grant_felt_ui_foreground_right(self):
        """Stand in for the application the user clicks a link in. That
        application holds the foreground right and Windows lets it pass the
        right on to the Felt UI. This harness runs from a background console
        and has no such right, so it first earns one with a synthetic key
        press (the process that produced the last input event may set the
        foreground) and then hands it to the Felt UI process."""
        user32 = ctypes.windll.user32
        VK_SHIFT, KEYEVENTF_KEYUP = 0x10, 0x0002
        user32.keybd_event(VK_SHIFT, 0, 0, 0)
        user32.keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, 0)
        felt_pid = self._driver.session_capabilities["moz:processID"]
        granted = user32.AllowSetForegroundWindow(felt_pid)
        assert granted, (
            f"harness could not grant the foreground right to Felt UI pid {felt_pid}"
        )
        self._logger.info(f"Granted the foreground right to Felt UI pid {felt_pid}")

    def get_foreground_hwnd(self):
        return ctypes.windll.user32.GetForegroundWindow()
