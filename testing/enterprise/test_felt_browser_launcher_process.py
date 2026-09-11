#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class BrowserLauncherProcess(FeltTests):
    def test_browser_started_via_launcher(self):
        """Felt must start the browser through the launcher process, which
        patches security enhancements into the browser process. The dynamic
        blocklist is only available if the browser was started through the
        launcher process, so we can check for that to verify it."""
        self.run_felt_base()
        self.connect_child_browser()

        with self._child_driver.using_context(self._child_driver.CONTEXT_CHROME):
            available = self._child_driver.execute_script(
                """
                return Cc["@mozilla.org/about-thirdparty;1"].getService(
                  Ci.nsIAboutThirdParty
                ).isDynamicBlocklistAvailable;
                """
            )

        self._logger.info(f"isDynamicBlocklistAvailable: {available}")

        assert available, (
            "Expected the browser to be started by a launcher process, but it "
            "has no shared section (isDynamicBlocklistAvailable is false)"
        )
