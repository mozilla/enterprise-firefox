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


class FeltStartsBrowserCli(FeltStartsBrowser):
    def test_felt_browser_start_from_cli(self):
        super().run_felt_base()
        self.run_felt_browser_started()
        self.run_ensure_firefox_config_set_in_browser()
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
