#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.


import felt_consts
from felt_tests import FeltTests


class FeltStartsBrowser(FeltTests):
    def python_type_to_js(self, value):
        rv = None
        py_type = type(value)
        if py_type is str:
            rv = "String"
        elif py_type is float:
            rv = "Float"
        elif py_type is int:
            rv = "Int"
        elif py_type is bool:
            rv = "Bool"
        return rv

    def run_felt_browser_started(self):
        self.connect_child_browser()
        self.open_tab_child(f"http://localhost:{self.sso_port}/sso_page")

        expected_cookie = list(
            filter(
                lambda x: x["name"] == self.cookie_name.value
                and x["value"] == self.cookie_value.value,
                self._child_driver.get_cookies(),
            )
        )
        assert len(expected_cookie) == 1, (
            f"Cookie {self.cookie_name} was properly set on Firefox started by FELT"
        )

    def run_ensure_firefox_config_set_in_browser(self):
        for key, entry in felt_consts.firefox_config.items():
            pref_id = entry["pref_id"]
            expected_value = entry["pref_value"]

            value = self.get_pref_child(pref_id, self.python_type_to_js(expected_value))

            assert value == expected_value, (
                f"[{key}] Mismatching pref {pref_id} value {value} instead of {expected_value}"
            )
