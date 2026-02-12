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

    def run_felt_verify_prefs(self):
        for pref in felt_consts.live_prefs + felt_consts.userjs_prefs:
            value = self.get_pref_child(pref[0], self.python_type_to_js(pref[1]))
            assert value == pref[1], (
                f"Mismatching pref {pref[0]} value {value} instead of {pref[1]}"
            )
