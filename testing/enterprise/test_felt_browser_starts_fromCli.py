#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import sys

import portpicker
from felt_tests import FeltTests


class FeltStartsBrowserCli(FeltTests):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def test_felt_3_browser_started(self, exp):
        self.connect_child_browser()
        self.open_tab_child(f"http://localhost:{self.sso_port}/sso_page")

        expected_cookie = list(
            filter(
                lambda x: x["name"] == self.cookie_name
                and x["value"] == self.cookie_value,
                self._child_driver.get_cookies(),
            )
        )
        assert (
            len(expected_cookie) == 1
        ), f"Cookie {self.cookie_name} was properly set on Firefox started by FELT"

        return True


if __name__ == "__main__":
    port_console = portpicker.pick_unused_port()
    port_sso_serv = portpicker.pick_unused_port()
    FeltStartsBrowserCli(
        "felt_browser_starts_fromCli.json",
        firefox=sys.argv[1],
        geckodriver=sys.argv[2],
        profile_root=sys.argv[3],
        console=port_console,
        sso_server=port_sso_serv,
        cli_args=["-feltUI"],
    )
