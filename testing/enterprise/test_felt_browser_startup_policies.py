#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests

# DisableThirdPartyModuleBlocking is read by the Windows launcher process, long
# before the policy engine exists, so Felt passes it in the environment. Its
# only reader lives in browser/app/winlauncher, making it Firefox-only.


class BrowserStartupPolicyDisableThirdPartyModuleBlocking(FeltTests):
    def test_disable_third_party_module_blocking(self):
        self._logger.info(
            "Serving DisableThirdPartyModuleBlocking before the browser spawns"
        )
        self.policy_disable_third_party_module_blocking.value = 1

        self.run_felt_base()
        self.connect_child_browser()

        # Whether the launcher process actually skipped SetBlocklist is not
        # observable from marionette, so this covers the delivery of the
        # variable and the policy engine's own view of the feature.
        assert (
            self.get_env_child("MOZ_ENTERPRISE_DISABLE_THIRD_PARTY_MODULE_BLOCKING")
            == "1"
        ), (
            "Browser should have been spawned with "
            "MOZ_ENTERPRISE_DISABLE_THIRD_PARTY_MODULE_BLOCKING"
        )

        self._child_driver.set_context("chrome")
        allowed = self._child_driver.execute_script(
            "return Services.policies.isAllowed('thirdPartyModuleBlocking');"
        )
        self._child_driver.set_context("content")

        assert allowed is False, (
            "DisableThirdPartyModuleBlocking should disallow thirdPartyModuleBlocking"
        )


class BrowserStartupPolicyDisableThirdPartyModuleBlockingUnset(FeltTests):
    def test_third_party_module_blocking_env_absent_without_policy(self):
        self.run_felt_base()
        self.connect_child_browser()

        assert (
            self.get_env_child("MOZ_ENTERPRISE_DISABLE_THIRD_PARTY_MODULE_BLOCKING")
            == ""
        ), (
            "No DisableThirdPartyModuleBlocking policy should mean no environment "
            "variable"
        )
