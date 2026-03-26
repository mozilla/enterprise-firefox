#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import platform
import re
import sys
import time

sys.path.append(os.path.dirname(__file__))

import requests
from felt_tests import FeltTests


class FeltDevicePosture(FeltTests):
    def test_felt_device_posture(self):
        super().run_felt_base()
        self.run_device_posture_content()
        self.run_access()
        self.run_posture_history()

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
    def test_felt_1_perform_sso_auth(self):
        TODO: Behavior is not yet clearly defined
        self._logger.info("Setting forbidden device posture")
        self.device_posture_reply_forbidden.value = 1
        self._manually_closed_child = True
        self._logger.info("Setting forbidden device posture done")
        return super().test_felt_1_perform_sso_auth(exp)
        """

    def run_device_posture_content(self):
        device_posture = self.get_device_posture()
        assert "name" in device_posture["os"], "Device posture reports OS name"
        assert "version" in device_posture["os"], "Device posture reports OS version"
        assert device_posture["build"]["applicationName"] == "FirefoxEnterprise", (
            "Device posture reports proper applicationName"
        )
        assert "secureBootEnabled" in device_posture

        os_long_name = device_posture["os"].get("os_long_name")

        assert os_long_name and len(os_long_name) > 0, (
            "Device posture reports os_long_name"
        )
        if sys.platform == "darwin":
            # e.g. "macOS 15.3.1 (Sequoia)"
            assert re.match(r"^macOS \d+(\.\d+)+( \(\w[\w ]*\))?$", os_long_name), (
                f"os_long_name '{os_long_name}' does not match expected macOS format"
            )
            actual_version = platform.mac_ver()[0]
            assert actual_version in os_long_name, (
                f"os_long_name '{os_long_name}' should contain macOS version '{actual_version}'"
            )
        elif sys.platform == "win32":
            actual_build = platform.win32_ver()[1].split(".")[-1]
            # e.g. "Windows 11 22H2 (build 22621)", "Windows 10 (build 19045)",
            # or "Windows Server 2025 24H2 (build 26100)"
            assert re.match(
                r"^Windows( Server)? \d+( \w+)? \(build \d+\)$", os_long_name
            ), f"os_long_name '{os_long_name}' does not match expected Windows format"
            assert actual_build in os_long_name, (
                f"os_long_name '{os_long_name}' should contain build number '{actual_build}'"
            )
        elif sys.platform == "linux":
            os_release = platform.freedesktop_os_release()
            pretty_name = os_release.get("NAME", "")
            if pretty_name == "Ubuntu":
                version_id = os_release.get("VERSION_ID", "")
                assert pretty_name in os_long_name, (
                    f"os_long_name '{os_long_name}' should contain NAME '{pretty_name}'"
                )
                assert version_id in os_long_name, (
                    f"os_long_name '{os_long_name}' should contain VERSION_ID '{version_id}'"
                )
                # e.g. "Ubuntu 22.04 (5.15.0-91-generic)"
                assert re.match(
                    rf"^{re.escape(pretty_name)} \d+(\.\d+)+ \(\S+\)$", os_long_name
                ), f"os_long_name '{os_long_name}' does not match expected Linux format"

        os_short_name = device_posture["os"].get("os_short_name")

        assert os_short_name and len(os_short_name) > 0, (
            "Device posture reports os_short_name"
        )
        if sys.platform == "darwin":
            # e.g. "macOS 15 (Sequoia)"
            assert re.match(r"^macOS \d+( \(\w[\w ]*\))?$", os_short_name), (
                f"os_short_name '{os_short_name}' does not match expected macOS format"
            )
            actual_major = platform.mac_ver()[0].split(".")[0]
            assert f"macOS {actual_major}" in os_short_name, (
                f"os_short_name '{os_short_name}' should contain macOS major version '{actual_major}'"
            )
        elif sys.platform == "win32":
            # e.g. "Windows 11", "Windows 10", or "Windows Server 2025"
            assert re.match(r"^Windows( Server)? \d+$", os_short_name), (
                f"os_short_name '{os_short_name}' does not match expected Windows format"
            )
        elif sys.platform == "linux":
            os_release = platform.freedesktop_os_release()
            pretty_name = os_release.get("NAME", "")
            if pretty_name == "Ubuntu":
                version_id = os_release.get("VERSION_ID", "")
                assert pretty_name in os_short_name, (
                    f"os_short_name '{os_short_name}' should contain NAME '{pretty_name}'"
                )
                assert version_id in os_short_name, (
                    f"os_short_name '{os_short_name}' should contain VERSION_ID '{version_id}'"
                )
                # e.g. "Ubuntu 22.04"
                assert re.match(
                    rf"^{re.escape(pretty_name)} \d+(\.\d+)+$", os_short_name
                ), (
                    f"os_short_name '{os_short_name}' does not match expected Linux format"
                )

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

        assert "extensions" in device_posture, "Device posture reports extensions"

    def run_posture_history(self):
        console_addr = f"http://localhost:{self.console_port}"
        # Wait until at least one posture has a non-null extensions field,
        # meaning the browser poll sent it after AddonManager was ready.
        max_tries = 40
        for _ in range(max_tries):
            r = requests.get(f"{console_addr}/sso/get_device_posture_history")
            history = r.json()
            has_extensions = any(p["extensions"] is not None for p in history)
            if len(history) >= 2 and has_extensions:
                break
            time.sleep(0.5)
        else:
            assert False, (
                f"Expected a posture with extensions list, got {len(history)} "
                f"submissions all with null extensions"
            )

        # The first posture comes from the FELT UI where AddonManager is
        # unavailable, so extensions must be null (not yet known).
        assert history[0]["extensions"] is None, (
            "First posture (FELT UI) has null extensions"
        )
        # Once the browser poll fires (after AddonManager is ready),
        # extensions must be a list.
        browser_posture = next(p for p in history if p["extensions"] is not None)
        assert isinstance(browser_posture["extensions"], list), (
            "Browser poll posture has extensions list"
        )

    def run_access(self):
        """
        TODO: Behavior is not yet clearly defined
        token_data = json.loads(
            self.find_elem_by_id("token_data").get_attribute("innerHTML")
        )
        assert len(token_data["access_token"]) == 0, "There is not access token"
        assert len(token_data["refresh_token"]) == 0, "There is not refresh token"
        """
        self.connect_child_browser()
