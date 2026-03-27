#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests


class BrowserInitFailures(FeltTests):
    def test_browser_init_policy_fetch_fail(self):
        self.policies_fail_request.value = 1
        super().run_felt_base()
        self._manually_closed_child = True

        self.await_felt_auth_window()
        self.policies_fail_request.value = 0
        self.force_window()
        self.assert_user_signed_out(env=Environment.FELT)
