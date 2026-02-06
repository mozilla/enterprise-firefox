#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import sys
import time

import requests
from felt_tests import FeltTests


class FeltDevicePosture(FeltTests):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def get_device_posture(self):
        console_addr = f"http://localhost:{self.console_port}"
        max_try = 0
        while max_try < 20:
            max_try += 1
            try:
                r = requests.get(f"{console_addr}/sso/get_device_posture")
                return r.json()
            except Exception as ex:
                self._logger.info(f"Console not yet online at {console_addr}: {ex}")
                time.sleep(0.5)

        """
    def test_felt_1_perform_sso_auth(self, exp):
        TODO: Behavior is not yet clearly defined
        self._logger.info("Setting forbidden device posture")
        self.device_posture_reply_forbidden.value = 1
        self._manually_closed_child = True
        self._logger.info("Setting forbidden device posture done")
        return super().test_felt_1_perform_sso_auth(exp)
        """

    def test_felt_2_device_posture_content(self, exp):
        device_posture = self.get_device_posture()
        assert "name" in device_posture["os"], "Device posture reports OS name"
        assert "version" in device_posture["os"], "Device posture reports OS version"
        assert device_posture["build"]["applicationName"] == "FirefoxEnterprise", (
            "Device posture reports proper applicationName"
        )
        assert "secureBootEnabled" in device_posture
        assert "mobileEquipmentId" in device_posture["network"], (
            "Device posture reports IMEI/MEID"
        )

        assert len(device_posture["network"]["interfaces"]) >= 1, (
            "Device posture reports at least one network interface"
        )

        found_one_ipv4 = False
        found_one_ipv6 = False

        for interface in device_posture["network"]["interfaces"]:
            if sys.platform == "linux" or sys.platform == "darwin":
                assert not interface["name"].startswith("lo"), (
                    "Device posture should not report loopback"
                )
            elif sys.platform == "win32":
                assert "loopback" not in interface["name"].lower(), (
                    "Device posture should not report loopback"
                )

            assert len(interface["mac"]) == 17, "Device posture reports MAC address"

            """
            Not all interfaces are expected to have IPv4 and/or IPv6 but we
            should have at least one of each over all interfaces.
            """

            num_ipv4 = len(interface["ipv4"])
            num_ipv6 = len(interface["ipv6"])

            assert num_ipv4 >= 0, "Device posture reports network interface IPv4"

            assert num_ipv6 >= 0, "Device posture reports network interface IPv6"

            if num_ipv4 > 0:
                found_one_ipv4 = True

            if num_ipv6 > 0:
                found_one_ipv6 = True

        assert found_one_ipv4, "Device posture reports network interfaces (IPv4)"

        assert found_one_ipv6, "Device posture reports network interfaces (IPv6)"

        return True

    def test_felt_3_access(self, exp):
        """
        TODO: Behavior is not yet clearly defined
        token_data = json.loads(
            self.find_elem_by_id("token_data").get_attribute("innerHTML")
        )
        assert len(token_data["access_token"]) == 0, "There is not access token"
        assert len(token_data["refresh_token"]) == 0, "There is not refresh token"
        """
        self.connect_child_browser()
        return True


if __name__ == "__main__":
    FeltDevicePosture(
        "felt_device_posture.json",
        firefox=sys.argv[1],
        geckodriver=sys.argv[2],
        profile_root=sys.argv[3],
        cli_args=["-feltUI"],
    )
