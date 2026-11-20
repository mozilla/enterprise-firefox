#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

import dbus

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests
from packagekit_mock import PackageKitMock


class FeltPackageKitUpdatesBase(FeltTests):
    EXTRA_PREFS = {
        "app.update.log": True,
        "enterprise.felt_tests.is_updates_testing": True,
    }

    def setUp(self):
        """
        Needs to call dbus-launch and set environment variables:
         - DBUS_SESSION_BUS_ADDRESS
         - DBUS_SYSTEM_BUS_ADDRESS
        So it needs to run FIRST
        """

        self.logger.info("Enabling mock PackageKit")

        self._mock = PackageKitMock(updates=self.UPDATES, delay=1.0, delay_download=0.5)
        self._mock.start()

        self.logger.info(f"Started mock PackageKit: {self._mock.bus_address}")

        env = os.environ.copy()
        env["DBUS_SESSION_BUS_ADDRESS"] = self._mock.bus_address
        env["DBUS_SYSTEM_BUS_ADDRESS"] = self._mock.bus_address

        self.logger.info(f"Enabled mock PackageKit: {self._mock.bus_address}")

        super().setUp()

    def tearDown(self):
        self.logger.info(f"Removing mock PackageKit: {self._mock.bus_address}")
        super().tearDown()
        self._mock.stop()

    def trigger_refresh_cache(self):
        self._driver.set_context("chrome")
        return self._driver.execute_async_script(
            """
            const callback = arguments[arguments.length - 1];
            const packageKitDBus = Cc["@mozilla.org/updates/packagekit-dbus-provider;1"].getService(Ci.nsIPackageKitDBusProvider);
            packageKitDBus.refreshCache(true, p => console.debug(`RefreshCache Progress: id:${p.id} :: status:${p.status} :: percentage:${p.percentage}`))
                .then(caches => callback(caches));
            """
        )

    def trigger_update_check(self):
        self._driver.set_context("chrome")
        return self._driver.execute_async_script(
            """
            const callback = arguments[arguments.length - 1];
            const packageKitDBus = Cc["@mozilla.org/updates/packagekit-dbus-provider;1"].getService(Ci.nsIPackageKitDBusProvider);
            packageKitDBus.getUpdates()
                .then(updates => callback(updates));
            """
        )

    def trigger_download_packages(self, package_ids):
        self._driver.set_context("chrome")
        return self._driver.execute_async_script(
            """
            const callback = arguments[arguments.length - 1];
            const packageKitDBus = Cc["@mozilla.org/updates/packagekit-dbus-provider;1"].getService(Ci.nsIPackageKitDBusProvider);
            packageKitDBus.downloadPackages(arguments[0])
                .then(pkgs => callback(pkgs));
            """,
            [package_ids],
        )

    def trigger_update_packages(self, package_ids):
        self._driver.set_context("chrome")
        return self._driver.execute_async_script(
            """
            const callback = arguments[arguments.length - 1];
            const packageKitDBus = Cc["@mozilla.org/updates/packagekit-dbus-provider;1"].getService(Ci.nsIPackageKitDBusProvider);
            packageKitDBus.updatePackages(arguments[0])
                .then(pkgs => callback(pkgs));
            """,
            [package_ids],
        )

    def run_refresh_cache(self):
        self.logger.info("PackageKitUpdates: getting")
        refresh_cache = self.trigger_refresh_cache()
        self.logger.info(f"PackageKitUpdates: refresh_cache:{refresh_cache}")
        return refresh_cache

    def run_get_all_updates(self):
        self.logger.info("PackageKitUpdates: getting")
        updates = self.trigger_update_check()
        self.logger.info(f"PackageKitUpdates: updates:{updates}")
        return updates

    def run_download_packages(self, pkg_id):
        self.logger.info("PackageKitUpdates: downloading")
        downloads = self.trigger_download_packages([pkg_id])
        self.logger.info(f"PackageKitUpdates: downloads:{downloads}")
        return downloads

    def run_update_packages(self, pkg_id):
        self.logger.info("PackageKitUpdates: updateing")
        updates = self.trigger_update_packages([pkg_id])
        self.logger.info(f"PackageKitUpdates: updates:{updates}")
        return updates

    def get_transaction_states(self):
        bus = dbus.bus.BusConnection(self._mock.bus_address)
        proxy = bus.get_object(
            "org.freedesktop.PackageKit", "/org/freedesktop/PackageKit"
        )
        iface = dbus.Interface(proxy, "org.freedesktop.PackageKit.Tests")

        raw_states = iface.GetTransactionStates()
        return [
            {
                "path": str(state[0]),
                "method": str(state[1]),
                "hints": [str(h) for h in state[2]],
                "interactive_auth": bool(state[3]),
            }
            for state in raw_states
        ]

    def assert_transactions(self):
        transactions = self.get_transaction_states()

        # Build a dictionary keyed by method name for easy lookup
        tx_by_method = {
            tx["method"]: tx for tx in transactions if tx["method"] != "Unknown"
        }

        expected_behaviors = {
            "GetUpdates": False,
            "DownloadPackages": False,
            "RefreshCache": True,
            "UpdatePackages": True,
        }

        # 3. Assert over all methods in a single loop
        for method, is_interactive in expected_behaviors.items():
            tx = tx_by_method.get(method)
            assert tx is not None, (
                f"Transaction for {method} was not found!\nAvailable: {transactions}"
            )

            if is_interactive:
                assert "interactive=true" in tx["hints"], (
                    f"{method} is missing interactive=true hint!\nActual tx data: {tx}"
                )
                assert "background=false" in tx["hints"], (
                    f"{method} is missing background=false hint!\nActual tx data: {tx}"
                )

                # Check the cleanly parsed boolean
                assert tx["interactive_auth"] is True, (
                    f"{method} is missing the ALLOW_INTERACTIVE_AUTHORIZATION flag!\nActual tx data: {tx}"
                )
            else:
                assert "background=true" in tx["hints"], (
                    f"{method} is missing background=true hint!\nActual tx data: {tx}"
                )
                assert "interactive=true" not in tx["hints"], (
                    f"{method} incorrectly requested interactive=true!\nActual tx data: {tx}"
                )

                # Ensure it remains false for background tasks
                assert tx["interactive_auth"] is False, (
                    f"{method} incorrectly set the ALLOW_INTERACTIVE_AUTHORIZATION flag!\nActual tx data: {tx}"
                )
