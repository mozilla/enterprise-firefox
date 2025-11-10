#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import configparser
import os
import sys

from base_test import EnterpriseTestsBase
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC


class EnterpriseTests(EnterpriseTestsBase):
    def __init__(self, firefox, geckodriver, profile_root):
        super().__init__(
            "firefox_start.json",
            firefox,
            geckodriver,
            profile_root,
            extra_env={"MOZ_BYPASS_FELT": "1"},
        )

    def setup(self):
        pass

    def teardown(self):
        pass

    def test_about_support(self, exp):
        self.open_tab("about:support")

        version_box = self._wait.until(
            EC.visibility_of_element_located((By.ID, "version-box"))
        )
        self._wait.until(lambda d: len(version_box.text) > 0)
        self._logger.info(f"about:support version: {version_box.text}")
        self._logger.info(f"expected version: {exp['version_box']}")
        assert version_box.text == exp["version_box"], "version text should match"

        return True

    def test_about_buildconfig_enterprise_branding(self, exp):
        self.open_tab("about:buildconfig")

        build_flags_box = self._wait.until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, "p:last-child"))
        )
        self._wait.until(lambda d: len(build_flags_box.text) > 0)
        self._logger.info(f"about:buildconfig buildflags: {build_flags_box.text}")
        assert (
            exp["enterprise"] in build_flags_box.text
        ), "enterprise branding build flag should be there"

        return True


# Loaded from mach runner
if __name__ == "test_firefox_start":
    this = os.path.dirname(os.path.abspath(__file__))

    app_ini = configparser.ConfigParser()
    if "MOZ_FETCHES_DIR" in os.environ:
        root = os.path.join(
            os.environ.get("MOZ_FETCHES_DIR"), "firefox", "application.ini"
        )
        if sys.platform == "darwin":
            app_dir = list(
                filter(
                    lambda x: x.endswith(".app"),
                    os.listdir(os.environ.get("MOZ_FETCHES_DIR")),
                )
            )
            assert len(app_dir) == 1
            root = os.path.join(
                os.environ.get("MOZ_FETCHES_DIR"),
                app_dir[0],
                "Contents",
                "Resources",
                "application.ini",
            )
        app_ini.read(root)
    else:
        app_ini.read(
            os.path.join(os.environ.get("TOPOBJDIR"), "dist", "bin", "application.ini")
        )
    version = app_ini.get("App", "Version")

    json_in = os.path.join(this, "firefox_start.json.in")
    json_out = os.path.join(this, "firefox_start.json")
    with open(json_out, "w") as outfile:
        with open(json_in) as infile:
            json_in_content = infile.read()
            json_in_content_ready = json_in_content.replace(
                "#RUNTIME_VERSION#", version
            )
            outfile.write(json_in_content_ready)

if __name__ == "__main__":
    EnterpriseTests(
        firefox=sys.argv[1], geckodriver=sys.argv[2], profile_root=sys.argv[3]
    )
