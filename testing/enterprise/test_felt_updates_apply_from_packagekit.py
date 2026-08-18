#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_updates import FeltUpdatesBase
from packagekit_mock import (
    PK_INFO_NORMAL,
    PackageKitMock,
)


class FeltUpdatesApplyFromPackageKit(FeltUpdatesBase):
    EXTRA_PREFS = {
        "app.update.log": True,
        "app.update.use_package_kit": True,
        # During tests do not leak into user's directory
        "app.update.use_package_kit_dont_override_updates_dir": True,
        "app.update.disabledForTesting": False,
        "enterprise.felt_tests.is_updates_testing": True,
    }

    UPDATES = [
        (
            PK_INFO_NORMAL,
            "firefoxenterprise;153.0.1;x86_64;updates",
            "Enterprise Browser",
        ),
    ]

    def setUp(self):
        """
        Needs to call dbus-launch and set environment variables:
         - DBUS_SESSION_BUS_ADDRESS
         - DBUS_SYSTEM_BUS_ADDRESS
        So it needs to run FIRST
        """

        self.logger.info("Enabling mock PackageKit")

        self._mock = PackageKitMock(updates=self.UPDATES, delay_download=6.0)
        self._mock.start()

        self.logger.info(f"Started mock PackageKit: {self._mock.bus_address}")

        env = os.environ.copy()
        env["DBUS_SESSION_BUS_ADDRESS"] = self._mock.bus_address
        env["DBUS_SYSTEM_BUS_ADDRESS"] = self._mock.bus_address

        self.logger.info(f"Enabled mock PackageKit: {self._mock.bus_address}")

        super().setUp()

    def tearDown(self):
        self.logger.info(f"Removing mock PackageKit: {self._mock.bus_address}")
        super().tearDown()
        self._mock.stop()

    def test_felt_updates_apply_from_packagekit(self):
        felt_pid = self._driver.session_capabilities["moz:processID"]
        self.run_felt_updates_apply()

        self.wait_process_exit(felt_pid)
        self._driver.start_session()

        package_id = self.UPDATES[0][1]
        expected_start = f"dbus://packagekit/{package_id}/"
        components = package_id.split(";")
        expected_end = f"{components[0]}-{components[1]}.{components[2]}.deb"
        self.assert_latest_update_url("succeeded", expected_start, expected_end)
