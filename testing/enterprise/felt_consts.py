#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.


live_prefs = [
    ["browser.sessionstore.restore_on_demand", False],
    ["browser.sessionstore.resume_from_crash", False],
    ["browser.policies.live_polling.frequency", 500],
]

userjs_prefs = [
    ["devtools.browsertoolbox.scope", "everything"],
    ["enterprise.console.test_float", 1.5],
    ["enterprise.console.test_bool", True],
]
