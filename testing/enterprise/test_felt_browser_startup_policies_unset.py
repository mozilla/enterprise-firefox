#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests

# Counterpart to test_felt_browser_startup_policies.py: with no
# DisableThirdPartyModuleBlocking served, the browser must not be given the
# environment variable at all.


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
