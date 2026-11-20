#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.


import felt_consts
from felt_tests import FeltTests

LEGACY_TOKENSERVER_PREF = "services.sync.tokenServerURI"


class FeltStartsBrowser(FeltTests):
    def run_felt_browser_started(self):
        self.connect_child_browser()
        self.open_tab_child(f"http://localhost:{self.sso_port}/sso_page")

        expected_cookie = list(
            filter(
                lambda x: (
                    x["name"] == self.cookie_name.value
                    and x["value"] == self.cookie_value.value
                ),
                self._child_driver.get_cookies(),
            )
        )
        assert len(expected_cookie) == 1, (
            f"Cookie {self.cookie_name} was properly set on Firefox started by FELT"
        )

    def get_service_prefs_child(self):
        """Tries to override each service URL pref, then returns its value,
        built-in default and locked state."""
        self._child_driver.set_context("chrome")
        prefs = self._child_driver.execute_script(
            """
            const [prefNames] = arguments;
            const prefs = {};
            for (const name of prefNames) {
              try {
                Services.prefs.setStringPref(name, "https://user.example/");
              } catch {}
              prefs[name] = {
                value: Services.prefs.getStringPref(name),
                default: Services.prefs.getDefaultBranch("").getStringPref(name),
                locked: Services.prefs.prefIsLocked(name),
              };
            }
            return prefs;
            """,
            [
                [
                    entry["pref_id"]
                    for entry in felt_consts.firefox_config.values()
                    if "pref_id" in entry
                ]
                + [LEGACY_TOKENSERVER_PREF]
            ],
        )
        self._child_driver.set_context("content")
        return prefs

    def run_ensure_firefox_config_set_in_browser(self):
        prefs = self.get_service_prefs_child()
        self._child_driver.set_context("chrome")
        config = self._child_driver.execute_script(
            "return JSON.parse(Services.felt.getFirefoxConfig());"
        )
        self._child_driver.set_context("content")

        for key, entry in felt_consts.firefox_config.items():
            expected_value = entry["pref_value"]
            assert config.get(key) == expected_value, (
                f"[{key}] Mismatching config value {config.get(key)} instead of {expected_value}"
            )
            if "pref_id" in entry:
                pref = prefs[entry["pref_id"]]
                assert pref["locked"], f"[{key}] {entry['pref_id']} is not locked"
                assert pref["value"] == expected_value, (
                    f"[{key}] Mismatching pref {entry['pref_id']} value {pref['value']} instead of {expected_value}"
                )

        legacy = prefs[LEGACY_TOKENSERVER_PREF]
        assert legacy["locked"], f"{LEGACY_TOKENSERVER_PREF} is not locked"
        assert legacy["value"] == "", (
            f"{LEGACY_TOKENSERVER_PREF} is {legacy['value']} instead of empty"
        )

    def run_ensure_service_prefs_locked_to_defaults(self):
        for name, pref in self.get_service_prefs_child().items():
            assert pref["locked"], f"{name} is not locked"
            assert pref["value"] == pref["default"], (
                f"{name} is {pref['value']} instead of its default {pref['default']}"
            )
