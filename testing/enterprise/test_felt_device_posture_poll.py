#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys
import time

sys.path.append(os.path.dirname(__file__))

import requests
from felt_tests import FeltTests


class FeltDevicePosturePoll(FeltTests):
    """Verify that device posture is sent from the browser on policy poll."""

    def test_device_posture_updated_by_poll(self):
        self.policy_extensions.value = 1
        super().run_felt_base()
        self.connect_child_browser()
        self.run_posture_updated_by_browser_poll()

    def get_device_posture(self):
        console_addr = f"http://localhost:{self.console_port}"
        r = requests.get(f"{console_addr}/sso/get_device_posture")
        return r.json()

    def run_posture_updated_by_browser_poll(self):
        # Regression: the initial FELT UI posture has extensions=null (JSON
        # null -> Python None). Verify the extraction logic doesn't crash.
        null_posture = {"extensions": None}
        null_exts = null_posture.get("extensions") or []
        assert [e["id"] for e in null_exts] == [], (
            "Null extensions must not raise TypeError"
        )

        # Poll the mock server until the browser's policy poll has sent a
        # posture that includes the force-installed extension.
        max_tries = 40
        for attempt in range(max_tries):
            posture = self.get_device_posture()
            extensions = posture.get("extensions") or []
            ext_ids = [e["id"] for e in extensions]
            if "treestyletab@piro.sakura.ne.jp" in ext_ids:
                break
            time.sleep(0.5)
        else:
            assert False, (
                "Device posture from policy poll did not include the "
                "force-installed extension within the timeout"
            )

        assert "name" in posture["os"], "Posture from poll reports OS name"
        assert posture["build"]["applicationName"] == "FirefoxEnterprise", (
            "Posture from poll reports proper applicationName"
        )

        tst = next(e for e in extensions if e["id"] == "treestyletab@piro.sakura.ne.jp")
        assert tst["name"] == "Tree Style Tab", (
            f"Extension display name is 'Tree Style Tab', got '{tst['name']}'"
        )
        assert tst["type"] == "extension", (
            f"Extension type is 'extension', got '{tst['type']}'"
        )
        assert tst["enabled"] is True, "Force-installed extension is enabled"
