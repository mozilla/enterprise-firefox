#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from test_felt_browser_updates_errors import FeltUpdatesErrorHandling

REPEAT = 50

for _i in range(1, REPEAT + 1):
    globals()[f"FeltUpdatesErrorHandling{_i}"] = type(
        f"FeltUpdatesErrorHandling{_i}", (FeltUpdatesErrorHandling,), {}
    )
