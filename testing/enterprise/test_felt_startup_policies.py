#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests

# DisableSafeMode is read before the policy engine exists, so Felt fetches it
# before spawning the child and passes it in the environment. The policy applies
# to both Firefox and Thunderbird, hence the generic manifest.


class StartupPolicyDisableSafeMode(FeltTests):
    def setUp(self):
        self._extra_cli_args = ["--safe-mode"]
        super().setUp()

    def test_disable_safe_mode(self):
        self._logger.info("Serving DisableSafeMode before the child spawns")
        self.policy_disable_safe_mode.value = 1

        self.run_felt_base()
        self.connect_child_browser()

        assert self.get_env_child("MOZ_ENTERPRISE_DISABLE_SAFE_MODE") == "1", (
            "Child should have been spawned with MOZ_ENTERPRISE_DISABLE_SAFE_MODE"
        )

        self._child_driver.set_context("chrome")
        safe_mode_child = self._child_driver.execute_script(
            "return Services.appinfo.inSafeMode;"
        )
        self._child_driver.set_context("content")

        # test_felt_browser_safe_mode.py covers the same launch without the
        # policy and asserts the child *is* in safe mode.
        assert safe_mode_child is False, (
            "DisableSafeMode should have kept the child out of safe mode"
        )


class StartupPolicyDisableSafeModeUnset(FeltTests):
    def test_safe_mode_env_absent_without_policy(self):
        self.run_felt_base()
        self.connect_child_browser()

        assert self.get_env_child("MOZ_ENTERPRISE_DISABLE_SAFE_MODE") == "", (
            "No DisableSafeMode policy should mean no environment variable"
        )
