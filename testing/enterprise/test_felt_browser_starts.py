#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_browser_starts import FeltStartsBrowser


class FeltStartsBrowserCli(FeltStartsBrowser):
    def test_felt_browser_start_from_cli(self):
        super().run_felt_base()
        self.run_felt_browser_started()
        self.run_felt_verify_prefs()
