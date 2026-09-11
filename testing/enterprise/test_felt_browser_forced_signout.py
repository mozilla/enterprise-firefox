#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_browser_starts import FeltStartsBrowser


class BrowserForcedSignout(FeltStartsBrowser):
    def test_forced_signout_waits_for_hook(self):
        self.run_felt_base()
        self.run_felt_browser_started()

        marker_path = os.path.join(self._child_profile_path, "forced-signout-hook")
        browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._manually_closed_child = True
        self._child_driver.set_context("chrome")
        expected_flags = self._child_driver.execute_script(
            "return Ci.nsIAppStartup.eForceQuit;"
        )

        try:
            self._child_driver.execute_script(
                """
                const { ConsoleClient } = ChromeUtils.importESModule(
                  "resource://gre/modules/enterprise/ConsoleClient.sys.mjs"
                );
                ConsoleClient.registerBeforeForcedQuitHook(async flags => {
                  await IOUtils.writeUTF8(arguments[0], String(flags));
                });
                Services.obs.notifyObservers(null, "felt-firefox-shutdown");
                """,
                script_args=(marker_path,),
            )
        except Exception:
            pass

        self.wait_process_exit(browser_pid)
        with open(marker_path) as marker:
            actual_flags = int(marker.read())
        assert actual_flags == expected_flags, (
            f"Expected forced-quit flags {expected_flags}, got {actual_flags}"
        )

    def test_forced_signout_hook_failure_still_quits(self):
        self.run_felt_base()
        self.run_felt_browser_started()

        browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._manually_closed_child = True
        self._child_driver.set_context("chrome")

        try:
            self._child_driver.execute_script(
                """
                const { ConsoleClient } = ChromeUtils.importESModule(
                  "resource://gre/modules/enterprise/ConsoleClient.sys.mjs"
                );
                ConsoleClient.registerBeforeForcedQuitHook(() => {
                  throw new Error("Expected forced-signout hook failure");
                });
                Services.obs.notifyObservers(null, "felt-firefox-shutdown");
                """
            )
        except Exception:
            pass

        self.wait_process_exit(browser_pid)
