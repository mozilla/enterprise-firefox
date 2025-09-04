#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import sys
import os
import random
import tempfile
import time

from test_base import EnterpriseTestsBase
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.select import Select

class EnterpriseTests(EnterpriseTestsBase):
    def __init__(self, exp, firefox, geckodriver, profile_root):
        super(__class__, self).__init__(exp, firefox, geckodriver, profile_root)

    def test_about_support(self, exp):
        self.open_tab("about:support")

        version_box = self._wait.until(
            EC.visibility_of_element_located((By.ID, "version-box"))
        )
        self._wait.until(lambda d: len(version_box.text) > 0)
        self._logger.info(f"about:support version: {version_box.text}")
        assert version_box.text == exp["version_box"], "version text should match"

        return True

    def test_about_buildconfig(self, exp):
        self.open_tab("about:buildconfig")

        build_flags_box = self._wait.until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, "p:last-child"))
        )
        self._wait.until(lambda d: len(build_flags_box.text) > 0)
        self._logger.info(f"about:support buildflags: {build_flags_box.text}")
        assert (
            build_flags_box.text.find(exp["official"]) >= 0
        ), "official build flag should be there"

        return True


if __name__ == "__main__":
    EnterpriseTests(exp=sys.argv[1], firefox=sys.argv[2], geckodriver=sys.argv[3], profile_root=sys.argv[4])
