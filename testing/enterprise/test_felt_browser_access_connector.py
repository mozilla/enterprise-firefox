#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys
import time

sys.path.append(os.path.dirname(__file__))

from felt_consts import firefox_config
from felt_tests import FeltTests
from marionette_driver.errors import NoSuchElementException, UnknownException


class BrowserAccessConnector(FeltTests):
    def test_browser_access_connector_default_on(self):
        self._logger.info("Enabling AccessConnector")
        self.run_change_access_connector_policy(1)
        self.run_felt_base()
        self.connect_child_browser()

        self.run_access_connector_enabled_in_browser()
        self.run_load_page_with_access_connector()

        self.run_disable_access_connector()
        self.run_enable_access_connector()
        self.run_disable_access_connector()
        self.run_enable_access_connector()
        self.run_disable_access_connector()

    def test_browser_access_connector_default_off(self):
        self._logger.info("Disabling AccessConnector")
        self.run_change_access_connector_policy(0)
        self.run_felt_base()
        self.connect_child_browser()

        self.run_access_connector_disabled_in_browser()
        self.run_load_page_without_access_connector()

        self.run_enable_access_connector()
        self.run_disable_access_connector()
        self.run_enable_access_connector()
        self.run_disable_access_connector()

    def test_browser_access_connector_neterror_page(self):
        self._logger.info("Enabling AccessConnector")
        self.run_change_access_connector_policy(1)
        self.run_felt_base()
        self.connect_child_browser()

        self.run_access_connector_enabled_in_browser()
        self.run_access_connector_neterror_page()

    def run_enable_access_connector(self):
        self._logger.info("Enabling AccessConnector")
        self.run_change_access_connector_policy(1)
        self.run_access_connector_enabled_in_browser()
        self.run_load_page_with_access_connector()

    def run_disable_access_connector(self):
        self._logger.info("Disabling AccessConnector")
        self.run_change_access_connector_policy(0)
        self.run_access_connector_disabled_in_browser()
        self.run_load_page_without_access_connector()

    def get_pref_value_and_locked_state(self, pref):
        with self._child_driver.using_context(self._child_driver.CONTEXT_CHROME):
            return self._child_driver.execute_script(
                """
                const { Preferences } = ChromeUtils.importESModule(
                  "resource://gre/modules/Preferences.sys.mjs"
                );

                const pref = arguments[0];
                const defaultBranch = arguments[1];
                const valueType = arguments[2];

                const prefs = new Preferences({defaultBranch: defaultBranch});
                const value = prefs.get(pref, null, Components.interfaces[valueType]);
                console.debug(`Felt: Test: prefs.get(${pref}) => ${value}`);
                const isLocked = prefs.locked(pref);

                return { [pref]: { "value": value, "isLocked": isLocked } };
                """,
                script_args=(pref, False, "unspecified"),
            )

    def get_access_connector_prefs_states(self):
        rv = {}
        rv.update(
            self.get_pref_value_and_locked_state(
                "browser.ipProtection.features.autoStart"
            )
        )
        rv.update(
            self.get_pref_value_and_locked_state(
                "browser.ipProtection.autoStartEnabled"
            )
        )
        rv.update(self.get_pref_value_and_locked_state("browser.ipProtection.mode"))
        rv.update(
            self.get_pref_value_and_locked_state(
                "browser.ipProtection.override.serverlist"
            )
        )
        rv.update(
            self.get_pref_value_and_locked_state(
                "browser.ipProtection.inclusion.match_patterns"
            )
        )
        rv.update(
            self.get_pref_value_and_locked_state(
                "browser.ipProtection.openedPanelWithLocation"
            )
        )
        rv.update(self.get_pref_value_and_locked_state("browser.ipProtection.enabled"))
        return rv

    def get_access_connector_icon_is_displayed(self):
        with self._child_driver.using_context(self._child_driver.CONTEXT_CHROME):
            try:
                ipprotection = self.find_elem_child("#ipprotection-button")
                return ipprotection.is_displayed()
            except NoSuchElementException:
                return False

    def get_access_connector_icon_is_green(self):
        with self._child_driver.using_context(self._child_driver.CONTEXT_CHROME):
            try:
                ipprotection = self.find_elem_child("#ipprotection-button")
                classes = ipprotection.get_attribute("class")
                return "ipprotection-on" in classes
            except NoSuchElementException:
                return False

    def run_access_connector_enabled_in_browser(self):
        self._logger.info("Checking access connectors state is on")
        state = self.get_access_connector_prefs_states()
        assert state["browser.ipProtection.features.autoStart"]["value"]
        assert state["browser.ipProtection.features.autoStart"]["isLocked"]
        assert state["browser.ipProtection.autoStartEnabled"]["value"]
        assert state["browser.ipProtection.autoStartEnabled"]["isLocked"]
        assert state["browser.ipProtection.mode"]["value"] == 3
        assert state["browser.ipProtection.mode"]["isLocked"]
        assert (
            state["browser.ipProtection.override.serverlist"]["value"]
            == '[{"code":"US","cities":[{"servers":[{"host":"proxy","port":"18443","protocols":[{"name":"connect","port":"18443","host":"proxy","scheme":"https"}]}]}]}]'
        )
        assert state["browser.ipProtection.override.serverlist"]["isLocked"]
        assert (
            state["browser.ipProtection.inclusion.match_patterns"]["value"]
            == '["https://*.mozilla.org"]'
        )
        assert state["browser.ipProtection.inclusion.match_patterns"]["isLocked"]
        assert state["browser.ipProtection.openedPanelWithLocation"]["value"]
        assert state["browser.ipProtection.openedPanelWithLocation"]["isLocked"]
        assert state["browser.ipProtection.enabled"]["value"]
        assert state["browser.ipProtection.enabled"]["isLocked"]

    def run_access_connector_disabled_in_browser(self):
        self._logger.info("Checking access connectors state is off")
        state = self.get_access_connector_prefs_states()
        assert not state["browser.ipProtection.features.autoStart"]["value"]
        assert not state["browser.ipProtection.features.autoStart"]["isLocked"]
        assert not state["browser.ipProtection.autoStartEnabled"]["value"]
        assert not state["browser.ipProtection.autoStartEnabled"]["isLocked"]
        assert not state["browser.ipProtection.mode"]["isLocked"]
        assert not state["browser.ipProtection.mode"]["value"]
        assert not state["browser.ipProtection.override.serverlist"]["isLocked"]
        assert not state["browser.ipProtection.override.serverlist"]["value"]
        assert not state["browser.ipProtection.inclusion.match_patterns"]["isLocked"]
        assert not state["browser.ipProtection.inclusion.match_patterns"]["value"]
        assert not state["browser.ipProtection.openedPanelWithLocation"]["value"]
        assert not state["browser.ipProtection.openedPanelWithLocation"]["isLocked"]
        assert not state["browser.ipProtection.enabled"]["value"]
        assert not state["browser.ipProtection.enabled"]["isLocked"]

    def run_change_access_connector_policy(self, new_value):
        self._logger.info("Changing Access Connectors policy")
        self.policy_access_connector.value = new_value

        # Polling frequency + 1s
        waiting_time = (firefox_config["polling_frequency"]["pref_value"] / 1000) + 1
        # Give time to make sure Policy got applied
        time.sleep(waiting_time)
        self._logger.info(
            f"Policy should have been applied after waiting {waiting_time}s, continue tests"
        )

    def run_load_page_ok(self, url, expected_title):
        self.open_tab_child(url)
        self._child_longwait.until(lambda d: len(d.title) > 0)
        found_title = self._child_driver.title
        assert found_title == expected_title, (
            f"No access connector used, expected '{expected_title}', found '{found_title}'"
        )

    def run_load_page_with_access_connector(self):
        with self.assertRaisesRegex(
            UnknownException,
            r"Reached error page: about:neterror\?e=proxyResolveFailure&u=https%3A//support\.mozilla\.org",
        ):
            self.open_tab_child("https://support.mozilla.org/en-US/")
            assert self.get_access_connector_icon_is_displayed(), (
                "Access Connector icon is displayed"
            )
            assert self.get_access_connector_icon_is_green(), (
                "Access Connector icon is reporting active"
            )
        self.run_load_page_ok(f"http://localhost:{self.console_port}/ping", "Pong!")

    def run_load_page_without_access_connector(self):
        self.run_load_page_ok("https://support.mozilla.org/en-US/", "Mozilla Support")
        assert not self.get_access_connector_icon_is_displayed(), (
            "Access Connector icon is not displayed"
        )
        assert not self.get_access_connector_icon_is_green(), (
            "Access Connector icon is reporting inactive"
        )
        self.run_load_page_ok(f"http://localhost:{self.console_port}/ping", "Pong!")

    def run_access_connector_neterror_page(self):
        self._logger.info("Navigating to URL routed through access connector proxy")
        with self.assertRaisesRegex(
            UnknownException,
            r"Reached error page: about:neterror\?e=proxyResolveFailure",
        ):
            self.open_tab_child("https://support.mozilla.org/en-US/")

        self._child_driver.set_context("content")

        self._logger.info("Waiting for access connector error page to render")
        self._child_longwait.until(
            lambda d: d.execute_script(
                "return !!document.querySelector('net-error-card')?.shadowRoot"
            )
        )

        self.run_check_access_connector_neterror_card()

    def run_check_access_connector_neterror_card(self):
        self._logger.info("Checking custom error title l10n id")
        title_l10n_id = self._child_driver.execute_script(
            """
            const card = document.querySelector("net-error-card");
            return card?.shadowRoot?.querySelector("#error-title")
                ?.getAttribute("data-l10n-id");
            """
        )
        assert title_l10n_id == "fp-neterror-access-connector-error-title", (
            f"Expected access connector error title, got: {title_l10n_id}"
        )

        self._logger.info("Checking error page illustration image")
        image_src = self._child_driver.execute_script(
            """
            const card = document.querySelector("net-error-card");
            return card?.shadowRoot?.querySelector(".img-container img")
                ?.getAttribute("src");
            """
        )
        assert image_src == (
            "chrome://global/skin/enterprise/access-connector-neterror.svg"
        ), f"Expected access connector neterror image, got: {image_src}"

        self._logger.info("Checking Try Again button is present")
        has_try_again = self._child_driver.execute_script(
            """
            const card = document.querySelector("net-error-card");
            return !!card?.shadowRoot?.querySelector("#tryAgainButton");
            """
        )
        assert has_try_again, "Expected Try Again button on access connector error page"
