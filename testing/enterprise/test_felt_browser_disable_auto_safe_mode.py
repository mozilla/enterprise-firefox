#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys
import time

sys.path.append(os.path.dirname(__file__))

from felt_browser_crashes import BrowserCrashes
from felt_browser_safe_mode import BrowserSafeMode

# A browser crash makes the next startup count as a startup crash: user.js is
# re-applied on every launch, so last_success never matches the lock time, and
# with max_resumed_crashes at 0 a single crash is enough for
# nsAppStartup::TrackStartupCrashBegin to ask for a restart in safe mode.
# always_use_safe_mode makes nsAppStartup ignore MOZ_DISABLE_AUTO_SAFE_MODE (and
# the debug build override), so only MOZ_ENTERPRISE_DISABLE_SAFE_MODE, passed by
# Felt with DisableSafeMode, can veto it.


class BrowserDisableAutoSafeMode(BrowserSafeMode, BrowserCrashes):
    # Felt does not pass on the safe mode request, so without the veto every
    # relaunch would count as another startup crash and restart again. Fail at
    # reconnecting instead.
    EXTRA_PREFS = {"enterprise.disable_restart": True}
    EXTRA_CHILD_PREFS = {
        "toolkit.startup.always_use_safe_mode": True,
        "toolkit.startup.max_resumed_crashes": 0,
        "toolkit.startup.last_success": 1,
    }

    def test_browser_disable_auto_safe_mode(self):
        self._logger.info("Serving DisableSafeMode before the browser spawns")
        self.policy_disable_safe_mode.value = 1

        self.run_felt_base()

        self._manually_closed_child = True
        self.connect_child_browser()
        crashed_at_ms = time.time() * 1000
        self.crash_parent()

        self.wait_process_exit(self._browser_pid)
        self._logger.info("Connecting to the browser restarted after the crash")
        self.connect_child_browser()
        self._manually_closed_child = False

        # nsAppStartup::TrackStartupCrashEnd records startupCrashDetectionEnd and
        # clears recent_crashes in one main-thread task, so reading both in the
        # same script tells whether the count is still there to check.
        self._child_driver.set_context("chrome")
        recent_crashes, detection_ended, auto_safe_mode, replaced_lock_time = (
            self._child_driver.execute_script(
                """
                return [
                  Services.prefs.getIntPref("toolkit.startup.recent_crashes", 0),
                  "startupCrashDetectionEnd" in Services.startup.getStartupInfo(),
                  Services.startup.automaticSafeModeNecessary,
                  Services.appinfo.replacedLockTime,
                ];
                """
            )
        )
        self._child_driver.set_context("content")

        if detection_ended:
            self._logger.info(
                "Startup crash tracking already ended; recent_crashes was cleared"
            )
        else:
            assert recent_crashes == 1, (
                f"The crash should have been counted as a startup crash, recent_crashes was {recent_crashes}"
            )
        assert auto_safe_mode is False, (
            "DisableSafeMode should have vetoed the automatic safe mode restart"
        )
        # The lock this browser replaced is the crashed browser's only if no
        # automatic restart happened in between.
        assert 0 < replaced_lock_time < crashed_at_ms, (
            f"The browser should have been relaunched once after the crash, "
            f"but replaced a lock from {replaced_lock_time} (crashed at {crashed_at_ms})"
        )

        self._logger.info("Enable ExtensionSettings policy")
        self.policy_extensions.value = 1

        self.run_felt_assert_safe_mode(False)

        self._logger.info("Disable ExtensionSettings policy")
        self.policy_extensions.value = 0
