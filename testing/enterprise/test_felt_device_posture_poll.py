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
    """Verify that device posture is POSTed with policy requests."""

    def test_device_posture_updated_by_poll(self):
        super().run_felt_base()
        self.connect_child_browser()
        self.run_posture_updated_by_browser_poll()

    def run_posture_updated_by_browser_poll(self):
        console_addr = f"http://localhost:{self.console_port}"
        # Poll the mock server until the browser's policy poll has sent
        # at least 2 postures (FELT UI + browser).
        max_tries = 40
        for _ in range(max_tries):
            r = requests.get(f"{console_addr}/sso/get_device_posture_history")
            history = r.json()
            if len(history) >= 2:
                break
            time.sleep(0.5)
        else:
            assert False, (
                f"Expected at least 2 posture submissions, got {len(history)}"
            )

        posture = history[-1]
        assert "name" in posture["os"], "Posture from poll reports OS name"
        assert posture["build"]["applicationName"] == "FirefoxEnterprise", (
            "Posture from poll reports proper applicationName"
        )
