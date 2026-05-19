#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import shutil
import sys
import tempfile

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class FeltStartsBrowserUtf8(FeltTests):
    def setUp(self):
        super().setUp()
        self._root_dir = tempfile.TemporaryDirectory(
            suffix="ééééutf8path", prefix="felt  àààà"
        )
        self._logger.info(f"Testing from UTF8 path: {self._root_dir}")
        self._driver.quit()
        existing = os.path.dirname(self._driver.instance.binary)
        # On macOS this gives us:
        #   obj-*/dist/Firefox EnterpriseDebug.app/Contents/MacOS/firefox => obj-*/dist/Firefox EnterpriseDebug.app/Contents/MacOS
        # But we want to copy whole .app directory
        if sys.platform == "darwin":
            existing = os.path.dirname(os.path.dirname(existing))
            assert existing.endswith(".app"), "Existing path {existing} should be .app"

        self._logger.info(f"Copying from {existing} to {self._root_dir.name}")
        shutil.copytree(
            existing, self._root_dir.name, symlinks=False, dirs_exist_ok=True
        )

        self._logger.info(f"Executing from {self._root_dir.name}")
        self._original_binary = self._driver.instance.binary
        if sys.platform == "darwin":
            self._driver.instance.binary = os.path.join(
                self._root_dir.name, "Contents", "MacOS", "firefox"
            )
        elif sys.platform == "win":
            self._driver.instance.binary = os.path.join(
                self._root_dir.name, "firefox.exe"
            )
        else:
            self._driver.instance.binary = os.path.join(self._root_dir.name, "firefox")
        self._driver.start_session()

    def teardown(self):
        super().teardown()
        self._driver.instance.binary = self._original_binary
        if os.path.isdir(self._root_dir.name):
            self._root_dir.cleanup()

    def test_felt_browser_start_from_utf8_path(self):
        super().run_felt_base()
        self.connect_child_browser()
        self.open_tab_child(f"http://localhost:{self.sso_port}/ping")
