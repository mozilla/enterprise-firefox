#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests

IMPORT_FORCED_QUIT_HANDLER = """
const { ForcedQuitHandler } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/enterprise/modules/ForcedQuitHandler.sys.mjs"
);
"""


class ForcedSignout(FeltTests):
    def test_forced_signout_waits_for_hook(self):
        self.run_felt_base()
        self.connect_child_browser()

        quit_flags_path = os.path.join(self._child_profile_path, "forced-signout-hook")
        browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._manually_closed_child = True
        self._child_driver.set_context("chrome")
        expected_flags = self._child_driver.execute_script(
            "return Ci.nsIAppStartup.eForceQuit;"
        )

        try:
            self._child_driver.execute_script(
                IMPORT_FORCED_QUIT_HANDLER
                + """
                ForcedQuitHandler._forcedQuitHook = async flags => {
                  await IOUtils.writeUTF8(arguments[0], String(flags));
                };
                Services.obs.notifyObservers(null, "felt-firefox-shutdown");
                """,
                script_args=(quit_flags_path,),
            )
        except Exception:
            pass

        self.wait_process_exit(browser_pid)
        with open(quit_flags_path) as quit_flags:
            actual_flags = int(quit_flags.read())
        assert actual_flags == expected_flags, (
            f"Expected forced-quit flags {expected_flags}, got {actual_flags}"
        )

    def test_forced_signout_hook_failure_still_quits(self):
        self.run_felt_base()
        self.connect_child_browser()

        browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._manually_closed_child = True
        self._child_driver.set_context("chrome")

        try:
            self._child_driver.execute_script(
                IMPORT_FORCED_QUIT_HANDLER
                + """
                ForcedQuitHandler._forcedQuitHook = () => {
                  throw new Error("Expected forced-signout hook failure");
                };
                Services.obs.notifyObservers(null, "felt-firefox-shutdown");
                """
            )
        except Exception:
            pass

        self.wait_process_exit(browser_pid)

    def test_forced_signout_hung_hook_still_quits(self):
        self.run_felt_base()
        self.connect_child_browser()

        browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._manually_closed_child = True
        self._child_driver.set_context("chrome")

        try:
            self._child_driver.execute_script(
                IMPORT_FORCED_QUIT_HANDLER
                + """
                Services.prefs.setIntPref(
                  "enterprise.felt.forced_quit_hook_timeout_ms",
                  2000
                );
                ForcedQuitHandler._forcedQuitHook = () => new Promise(() => {});
                Services.obs.notifyObservers(null, "felt-firefox-shutdown");
                """
            )
        except Exception:
            pass

        self.wait_process_exit(browser_pid)
