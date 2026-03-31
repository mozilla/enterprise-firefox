#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import json
import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class FeltCompulsoryRestart(FeltTests):
    def test_felt_update_ready_triggers_compulsory_restart(self):
        self.run_felt_base()
        self.connect_child_browser()

        pref_value = json.dumps({
            "NotificationPeriodHours": 0,
            "RestartTimeOfDay": {"Hour": 0, "Minute": 30},
        })

        with self._child_driver.using_prefs({
            "app.update.compulsory_restart": pref_value
        }):
            self._child_driver.set_context("chrome")

            self._child_driver.execute_script(
                'Services.obs.notifyObservers(null, "felt-update-ready");'
            )

            notification_value = self._child_wait.until(
                lambda mn: mn.execute_script(
                    """
                    let win = Services.wm.getMostRecentBrowserWindow();
                    for (let n of win.gNotificationBox.allNotifications) {
                        if (n.getAttribute("value") === "COMPULSORY_RESTART_SCHEDULED") {
                            return "COMPULSORY_RESTART_SCHEDULED";
                        }
                    }
                    return null;
                    """
                )
            )

            assert notification_value == "COMPULSORY_RESTART_SCHEDULED", (
                "felt-update-ready should trigger the compulsory restart notification"
            )

        self._child_driver.set_context("content")
