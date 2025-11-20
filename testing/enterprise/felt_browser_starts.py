#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.


from felt_tests import FeltTests


class FeltStartsBrowser(FeltTests):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def test_felt_3_browser_started(self, exp):
        self.connect_child_browser()
        self.open_tab_child(f"http://localhost:{self.sso_port}/sso_page")

        expected_cookie = list(
            filter(
                lambda x: x["name"] == self.cookie_name.value
                and x["value"] == self.cookie_value.value,
                self._child_driver.get_cookies(),
            )
        )
        assert (
            len(expected_cookie) == 1
        ), f"Cookie {self.cookie_name} was properly set on Firefox started by FELT"

        return True

    def test_felt_4_verify_prefs(self, exp):
        assert len(exp["prefs"]) > 0
        for pref in exp["prefs"]:
            value = self.get_pref_child(pref[0], pref[2])
            assert (
                value == pref[1]
            ), f"Mismatching pref {pref[0]} value {value} instead of {pref[1]}"

        return True
