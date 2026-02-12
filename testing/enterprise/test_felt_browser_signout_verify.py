#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from test_felt_browser_signout import BaseBrowserSignout


class BrowserSignoutVerify(BaseBrowserSignout):
    def test_browser_signout(self):
        super().run_felt_base()
        for i in range(10):
            self.run_browser_ui_state_when_user_is_logged_in()
            self.run_perform_signout()
            self.run_whoami()
            self.run_prefilled_email_submit()
            self.run_load_sso()
            self.run_perform_sso_auth()
        self._manually_closed_child = True
