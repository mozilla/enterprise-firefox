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
from base_test import Environment
from felt_tests import FeltTests


class FeltDevicePosture(FeltTests):
    # Identifiers of every EDR agent the EDR-checker knows about; must match
    # EdrId::as_str() in toolkit/components/felt/rust/src/edr_checker.rs.
    KNOWN_EDR_IDS = {
        "crowdstrike",
        "cortex-xdr",
        "sentinelone",
        "ms-defender",
        "carbon-black",
        "trellix",
        "sophos",
        "cisco-secure-endpoint",
        "eset",
        "cylance",
        "symantec",
        "trend-micro",
    }

    def test_felt_device_posture(self):
        # Keep the FELT window alive after login so EDR probing can run in the
        # FELT chrome context, where device posture is collected in production.
        self.get_driver(Environment.FELT).set_prefs(
            {"enterprise.felt_tests.should_not_close_window": True},
            default_branch=True,
        )
        super().run_felt_base()
        self.run_device_posture_content()
        # Connect the managed browser so its policy polls populate the posture
        # history that run_posture_history() checks.
        self.run_access()
        self.run_all_edr_detection()
        self.run_posture_history()

    def run_all_edr_detection(self):
        """Drive the EDR-checker directly against *every* known agent.

        The device-posture payload only probes a couple of agents, so this
        separately requests the full catalog (an empty id list means "all").
        Probing every agent exercises all detection methods on the host,
        including the service-status subprocess shell-outs (systemctl / service /
        rc-service on Linux, `sc` on Windows, systemextensionsctl on macOS) --
        the most brittle paths. We fire several probes concurrently so the
        in-flight coalescing is exercised too: a late caller must never observe a
        spurious empty result while a sweep is still running.
        """
        self._logger.info("Probing all EDR agents via the EDR-checker")
        driver = self.get_driver(Environment.FELT)
        driver.set_context("chrome")
        try:
            rv = driver.execute_async_script(
                """
                const callback = arguments[arguments.length - 1];
                const { EdrDetection } = ChromeUtils.importESModule(
                    "resource://gre/modules/enterprise/EdrDetection.sys.mjs"
                );
                // Empty list = probe every known agent. Three concurrent calls
                // exercise the background-thread sweep, the subprocess service
                // checks, and the in-flight coalescing.
                Promise.all([
                    EdrDetection.getPresentEdrs([]),
                    EdrDetection.getPresentEdrs([]),
                    EdrDetection.getPresentEdrs([]),
                ])
                    .then(results => callback({ results }))
                    .catch(err => callback({ _error: String(err) }));
                """,
            )
        finally:
            driver.set_context("content")

        assert "_error" not in rv, f"Probing all EDR agents threw: {rv.get('_error')}"
        results = rv["results"]
        assert len(results) == 3, "All three concurrent probe-all calls resolved"

        for present in results:
            assert isinstance(present, list), "getPresentEdrs([]) returns an array"
            for name in present:
                assert name in self.KNOWN_EDR_IDS, (
                    f"Probe-all returned an unknown EDR id: {name}"
                )

        # Coalescing invariant: every concurrent caller sees the same result.
        # Before the in-flight requests were coalesced, a second caller racing a
        # cold sweep could fall through to a still-empty cache and report a false
        # "none present"; identical results across concurrent calls guards that.
        assert results[0] == results[1] == results[2], (
            f"Concurrent probe-all calls disagreed: {results}"
        )
        self._logger.info(f"Probe-all EDR detection result: {sorted(results[0])}")

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

        app_name = self._driver.session_capabilities.get("browserName")
        expected_app_name = None
        if app_name == "firefox":
            expected_app_name = "FirefoxEnterprise"
        elif app_name == "thunderbird":
            expected_app_name = "ThunderbirdEnterprise"
        else:
            assert False, f"Unsupported app {app_name}"

        assert device_posture["build"]["applicationName"] == expected_app_name, (
            f"Expected device posture to report applicationName: '{expected_app_name}' but got '{device_posture['build']['applicationName']}'"
        )
        assert "secureBootEnabled" in device_posture

        assert "isDomainJoined" in device_posture
        assert isinstance(device_posture["isDomainJoined"], bool), (
            "isDomainJoined is a boolean"
        )

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

        assert "presentEdrs" in device_posture, "Device posture reports presentEdrs"
        present_edrs = device_posture["presentEdrs"]
        # We don't assert on which EDRs are present: the test host may legitimately
        # have one installed (e.g. a managed CI worker). Only the shape is checked.
        self._logger.info(f"EDR detection results: {present_edrs}")
        assert isinstance(present_edrs, list), "presentEdrs is an array"
        for edr in present_edrs:
            assert "name" in edr, "Each EDR entry has a name field"

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

            assert len(interface["mac"]) == 17, (
                "Device posture reports some MAC address"
            )
            assert interface["mac"] != "00:00:00:00:00:00", (
                f"Device posture missing MAC address for interface '{interface['name']}'"
            )

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

        # In the FELT UI context AddonManager is unavailable, so extensions is
        # null here; run_posture_history() asserts the populated browser-poll case.
        assert "extensions" in device_posture, "Device posture reports extensions"
        assert device_posture["extensions"] is None or isinstance(
            device_posture["extensions"], list
        ), "extensions is null or a list"

        # machineId is nullable (null when no platform identifier resolves); when
        # present, only its structure can be asserted, not the actual values.
        machine_id = device_posture["machineId"]
        assert machine_id is None or (
            isinstance(machine_id, dict)
            and "id" in machine_id
            and "source" in machine_id
        ), "machineId is null or an object with id and source"

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
