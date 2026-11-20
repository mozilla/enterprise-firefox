#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from packagekit_mock import (
    PK_INFO_BUGFIX,
    PK_INFO_ENHANCEMENT,
    PK_INFO_NORMAL,
    PK_INFO_SECURITY,
)
from packagekit_updates import FeltPackageKitUpdatesBase


class FeltPackageKitUpdates_NoFirefoxUpdate(FeltPackageKitUpdatesBase):
    UPDATES = [
        (
            PK_INFO_SECURITY,
            "bash;5.2.15;x86_64;repo-updates",
            "The GNU Bourne Again shell",
        ),
        (PK_INFO_NORMAL, "firefox;153.0.1;x86_64;repo-updates", "Web Browser"),
        (
            PK_INFO_SECURITY,
            "openssl;3.1.2;x86_64;repo-updates",
            "Utilities from the general purpose cryptography library",
        ),
        (
            PK_INFO_BUGFIX,
            "systemd;253.5;x86_64;repo-updates",
            "System and Service Manager",
        ),
        (PK_INFO_NORMAL, "nano;7.2;x86_64;repo-updates", "A small text editor"),
        (
            PK_INFO_ENHANCEMENT,
            "vim-enhanced;9.0.1;x86_64;repo-updates",
            "Enhanced VIM editor",
        ),
    ]

    def test_felt_updates_from_packagekit(self):
        self._manually_closed_child = True
        self.logger.info("PackageKitUpdates: running tests")
        assert len(self.run_get_all_updates()) == 0, (
            "There should be no update reported at all"
        )
