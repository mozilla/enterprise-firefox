#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_updater_errors import FeltUpdaterErrorsBase


class FeltUpdaterErrors(FeltUpdaterErrorsBase):
    EXTRA_PREFS = {
        "app.update.log": True,
        "app.update.disabledForTesting": False,
        "app.update.BITS.enabled": False,
        "enterprise.felt_tests.is_updates_testing": False,
    }

    def test_felt_updater_errors(self):
        self._update_root = os.path.dirname(self.get_update_config_file_path())
        self._updates_history = os.path.join(self._update_root, "updates.xml")
        self._logger.info(f"Updates history {self._updates_history}")

        if os.path.isfile(self._updates_history):
            os.unlink(self._updates_history)
            self._logger.info(f"Updates history {self._updates_history} removed.")

        # Browser is not being started in this test, so there is no need to
        # check for its proper close
        self._manually_closed_child = True

        self.reset_updates_served()
        self.reload_chrome_window()
        self.assert_updates_check_allowed(True)
        self.assert_updates_served(1)

        # Just one failure should not block
        self.write_updates_xml([self.one_xml("failed")])
        self.assert_updates_check_allowed(True)

        # Three consecutive failures, we still allow
        self.write_updates_xml([
            self.one_xml("failed"),
            self.one_xml("failed"),
            self.one_xml("failed"),
            self.one_xml("succeeded"),
        ])
        self.reset_updates_served()
        self.reload_chrome_window()
        self.assert_updates_check_allowed(True)
        self.assert_updates_served(1)

        # Four consecutive failures, we block
        self.write_updates_xml([
            self.one_xml("failed"),
            self.one_xml("failed"),
            self.one_xml("failed"),
            self.one_xml("failed"),
            self.one_xml("succeeded"),
        ])
        self.reset_updates_served()
        self.reload_chrome_window()
        self.assert_updates_check_allowed(False)
        self.assert_updates_served(0)
        self.assert_error_displayed()

        # This should count as two consecutive failures, so we still allow
        self.write_updates_xml([
            self.one_xml("failed"),
            self.one_xml("failed"),
            self.one_xml("succeeded"),
            self.one_xml("failed"),
            self.one_xml("failed"),
            self.one_xml("failed"),
            self.one_xml("failed"),
            self.one_xml("succeeded"),
        ])
        self.reset_updates_served()
        self.reload_chrome_window()
        self.assert_updates_check_allowed(True)
        self.assert_updates_served(1)

        # Four consecutive failures, but first is OK, we allow
        self.write_updates_xml([
            self.one_xml("succeeded"),
            self.one_xml("failed"),
            self.one_xml("failed"),
            self.one_xml("failed"),
            self.one_xml("failed"),
            self.one_xml("succeeded"),
        ])
        self.reset_updates_served()
        self.reload_chrome_window()
        self.assert_updates_check_allowed(True)
        self.assert_updates_served(1)

        assert os.path.isfile(self._updates_history), (
            f"Updates history is present at {self._updates_history}"
        )
        os.unlink(self._updates_history)
