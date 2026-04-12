#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from test_felt_browser_crash_abort_restart import BrowserCrashAbortRestart
from test_felt_browser_crash_restart import BrowserCrashRestart

REPEAT = 15

for _i in range(1, REPEAT + 1):
    globals()[f"BrowserCrash{_i}AbortRestart"] = type(
        f"BrowserCrash{_i}AbortRestart", (BrowserCrashAbortRestart,), {}
    )
    globals()[f"BrowserCrash{_i}Restart"] = type(
        f"BrowserCrash{_i}Restart", (BrowserCrashRestart,), {}
    )
