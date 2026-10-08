#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import json
import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_external_link import BaseBrowserExternalLink


class FeltStartsBrowserExternalLink(BaseBrowserExternalLink):
    def test_browser_external_link(self):
        self.run_felt_base()
        self._external_link = f"http://localhost:{self.console_port}/ping"
        self.run_felt_browser_started()
        self.run_felt_open_external_link()

    def test_browser_pending_external_link(self):
        self._external_link = "about:welcome"
        urls_file = os.path.join(self._driver.profile, "pendingURLs.json")

        assert not os.path.exists(urls_file), (
            f"Pending URLs file should not exist: {urls_file}"
        )
        self.third_party_open_external_link()

        self._logger.info(f"Waiting for pending URLs file to be populated: {urls_file}")
        self._wait.until(lambda mn: os.path.exists(urls_file))

        with open(urls_file) as pending:
            parsed = json.loads(pending.read())
            assert len(parsed["pendingURLs"]) == 1, (
                "There should be only one pending URL"
            )
            parsed_url = parsed["pendingURLs"][0]["url"]
            assert parsed_url == self._external_link, (
                f"Pending URL should be '{self._external_link}', found '{parsed_url}'"
            )

        self._driver.set_pref("enterprise.felt_tests.is_blocking_shutdown", True)
        self.run_felt_base()
        self.run_felt_browser_started()
        self.check_has_external_link_tab()

        self._logger.info(f"Waiting for pending URLs file to be cleared: {urls_file}")

        def has_no_pending_url(file):
            with open(file) as pending:
                parsed = json.loads(pending.read())
                return len(parsed["pendingURLs"]) == 0

        self._wait.until(lambda mn: has_no_pending_url(urls_file))
        self._logger.info(f"Pending URLs cleared from {urls_file}!")

        browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            """
            Services.startup.quit(Ci.nsIAppStartup.eForceQuit)
            """
        )
        self._manually_closed_child = False
        self.wait_process_exit(browser_pid)

        self._logger.info("Closing Felt")
        self._driver.quit(in_app=True, clean=False)

        # Write new content to the file, close the browser, wait for FELT and re-do everything
        with open(urls_file, "w") as pending:
            pending.write(
                json.dumps({
                    "pendingURLs": [
                        {
                            "url": "about:buildconfig",
                            "disposition": 0,
                        },
                        {
                            "url": "about:logo",
                            "disposition": 0,
                        },
                    ]
                })
            )
        self._logger.info(f"New pending URLs file: {urls_file}")

        self._driver.start_session(timeout=60)
        new_urls_file = os.path.join(self._driver.profile, "pendingURLs.json")
        assert os.path.exists(new_urls_file), (
            f"Pending URLs file should exists: {new_urls_file}"
        )

        self._driver.set_context("chrome")
        self._driver.execute_script(
            """
            console.debug(`Felt: Test: started new FELT`);
            """
        )

        self.run_felt_base()
        self.run_felt_browser_started()
        self.run_open_about_pages()
