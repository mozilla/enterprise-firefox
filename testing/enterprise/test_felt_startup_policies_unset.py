#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests

# Counterpart to test_felt_startup_policies.py: with no DisableSafeMode served,
# the child must not be given the environment variable at all.


class StartupPolicyDisableSafeModeUnset(FeltTests):
    def test_safe_mode_env_absent_without_policy(self):
        self.run_felt_base()
        self.connect_child_browser()

        assert self.get_env_child("MOZ_ENTERPRISE_DISABLE_SAFE_MODE") == "", (
            "No DisableSafeMode policy should mean no environment variable"
        )
