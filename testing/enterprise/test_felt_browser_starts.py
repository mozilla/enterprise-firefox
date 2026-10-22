#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import struct
import sys
from pathlib import Path

sys.path.append(os.path.dirname(__file__))

from felt_browser_starts import FeltStartsBrowser
from felt_consts import firefox_config

POLLING_INTERVAL_PREF = firefox_config["polling_frequency"]["pref_id"]


def ensure_polling_interval_locked(driver):
    expected = firefox_config["polling_frequency"]["pref_value"]
    driver.set_context("chrome")
    locked, value = driver.execute_script(
        """
        const [pref] = arguments;
        Services.prefs.setIntPref(pref, 2147483647);
        return [Services.prefs.prefIsLocked(pref), Services.prefs.getIntPref(pref)];
        """,
        [POLLING_INTERVAL_PREF],
    )
    driver.set_context("content")
    assert locked, f"{POLLING_INTERVAL_PREF} is not locked"
    assert value == expected, (
        f"{POLLING_INTERVAL_PREF} is {value} instead of {expected}"
    )


class FeltStartsBrowserPollingIntervalPlanted(FeltStartsBrowser):
    # A user value of another type must not prevent Felt from locking the pref.
    EXTRA_CHILD_PREFS = {POLLING_INTERVAL_PREF: "planted"}

    def test_felt_locks_planted_polling_interval(self):
        super().run_felt_base()
        self.run_felt_browser_started()
        ensure_polling_interval_locked(self._child_driver)


class FeltStartsBrowserCli(FeltStartsBrowser):
    def test_felt_browser_start_from_cli(self):
        super().run_felt_base()
        self.run_felt_browser_started()
        self.run_ensure_firefox_config_set_in_browser()
        ensure_polling_interval_locked(self._child_driver)
        self.run_ensure_profile_encryption(self._driver.profile)
        self.run_ensure_profile_encryption(self._child_driver.profile)

    def find_sqlite_files(self, directory, skip_names=("lockstore.keys.sqlite",)):
        return [
            f for f in Path(directory).rglob("*.sqlite") if f.name not in skip_names
        ]

    def get_sqlite_file(self, file):
        with open(file, "rb") as sqlite_file:
            h = sqlite_file.read(24)
            return struct.unpack(">H", h[16:18])[0], h[20]

    def run_ensure_profile_encryption(self, profile):
        self._logger.info(f"Checking encryption of {profile}")
        sqlite_files = self.find_sqlite_files(profile)
        for sqlite_file in sqlite_files:
            page_size, reserved = self.get_sqlite_file(sqlite_file)
            expected_page_size = [8192, 32768]
            expected_reserved = 32
            assert page_size in expected_page_size and reserved == expected_reserved, (
                f"SQLite encryption not enabled on {sqlite_file} "
                f"page_size={page_size} expected {expected_page_size} for encrypted ; "
                f"reserved={reserved} expected {expected_reserved} for encrypted"
            )
            self._logger.info(f"SQLite Encryption OK for database {sqlite_file}")
        self._logger.info(f"SQLite Encryption OK for profile {profile}")
