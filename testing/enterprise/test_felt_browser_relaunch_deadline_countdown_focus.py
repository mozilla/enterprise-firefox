#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_relaunch_deadline import IMMINENT_ID, BrowserRelaunchDeadlineBase


class BrowserRelaunchDeadlineCountdownFocus(BrowserRelaunchDeadlineBase):
    def test_relaunch_countdown_keeps_the_button_focused(self):
        self.run_felt_base()
        self.connect_child_browser()

        self.serve_relaunch({"MinutesRemaining": 4, "GracePeriodMinutes": 0})
        assert self.wait_for_relaunch_bar() == IMMINENT_ID, (
            "Expected the imminent bar for a budget inside the threshold"
        )
        self.assert_relaunch_message(
            "enterprise-relaunch-imminent-message", "will restart in 4 minutes"
        )

        self._logger.info("Focusing the restart button, then counting down")
        self.focus_restart_button()
        self.serve_relaunch({"MinutesRemaining": 3, "GracePeriodMinutes": 0})

        self.assert_relaunch_message(
            "enterprise-relaunch-imminent-message", "will restart in 3 minutes"
        )
        kept = self.check_focus_kept()
        assert kept["sameBar"], "The countdown replaced the bar instead of updating it"
        assert kept["focused"], "The countdown took focus off the restart button"

    def focus_restart_button(self):
        """Focuses the bar's button, remembering it and the bar it belongs to."""
        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            """
            const win = Services.wm.getMostRecentBrowserWindow();
            const bar = win.gNotificationBox.getNotificationWithValue(
                arguments[0]
            );
            win._relaunchTestBar = bar;
            win._relaunchTestButton = bar.buttonContainer.querySelector(".notification-button");
            win._relaunchTestButton.focus();
            """,
            script_args=(IMMINENT_ID,),
        )

    def check_focus_kept(self):
        self._child_driver.set_context("chrome")
        try:
            result = self._child_driver.execute_script(
                """
                const win = Services.wm.getMostRecentBrowserWindow();
                const bar = win.gNotificationBox.getNotificationWithValue(
                    arguments[0]
                );
                const result = {
                    sameBar: bar === win._relaunchTestBar,
                    focused: win.document.activeElement === win._relaunchTestButton,
                };
                delete win._relaunchTestBar;
                delete win._relaunchTestButton;
                return result;
                """,
                script_args=(IMMINENT_ID,),
            )
        finally:
            self._child_driver.set_context("content")
        return result
