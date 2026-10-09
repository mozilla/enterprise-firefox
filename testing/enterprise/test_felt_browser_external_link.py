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

    def test_pending_external_link_survives_update_restart(self):
        self._external_link = f"http://localhost:{self.console_port}/ping"
        self.third_party_open_external_link()
        self._driver.set_context("chrome")
        self._wait.until(
            lambda mn: mn.execute_script(
                "return ChromeUtils.importESModule("
                "'resource:///modules/FeltURLHandler.sys.mjs'"
                ").gFeltPendingURLs.length === 1;"
            )
        )

        def restart_for_update():
            self._driver.execute_script(
                "ChromeUtils.importESModule("
                "'resource://gre/modules/enterprise/Updates.sys.mjs'"
                ").Updates.automaticRestart();"
            )

        self._driver.restart(in_app=True, callback=restart_for_update)
        self._driver.set_context("chrome")
        restored = self._driver.execute_async_script(
            """
            const done = arguments[arguments.length - 1];
            const { gFeltPendingURLs } = ChromeUtils.importESModule(
              "resource:///modules/FeltURLHandler.sys.mjs"
            );
            gFeltPendingURLs.init().then(() => done({
              urls: [...gFeltPendingURLs],
              hasKey: !!Services.env.get("MOZ_FELT_PENDING_URLS_KEY"),
            }));
            """
        )
        assert [entry["url"] for entry in restored["urls"]] == [self._external_link]
        assert not restored["hasKey"], "The restart key must be consumed before login"
        assert not os.path.exists(
            os.path.join(self._driver.profile, "pendingURLs.json")
        )

        self.run_felt_base()
        self.run_felt_browser_started()
        self.check_has_external_link_tab()

    def test_pending_external_link_does_not_survive_ordinary_restart(self):
        self._external_link = "https://example.com/ordinary-restart"
        self.third_party_open_external_link()
        self._driver.set_context("chrome")
        self._wait.until(
            lambda mn: mn.execute_script(
                "return ChromeUtils.importESModule("
                "'resource:///modules/FeltURLHandler.sys.mjs'"
                ").gFeltPendingURLs.length === 1;"
            )
        )
        self._driver.restart(in_app=True)
        self._driver.set_context("chrome")
        count = self._driver.execute_async_script(
            """
            const done = arguments[arguments.length - 1];
            const { gFeltPendingURLs } = ChromeUtils.importESModule(
              "resource:///modules/FeltURLHandler.sys.mjs"
            );
            gFeltPendingURLs.init().then(() => done(gFeltPendingURLs.length));
            """
        )
        assert count == 0, "An ordinary restart must not restore queued URLs"
        self.run_felt_base()
        self.run_felt_browser_started()
        self.check_no_external_link_tab()

    def test_browser_pending_external_link(self):
        self._external_link = "about:welcome"
        urls_file = os.path.join(self._driver.profile, "pendingURLs.json")

        assert not os.path.exists(urls_file), (
            f"Pending URLs file should not exist: {urls_file}"
        )
        self.third_party_open_external_link()

        self._driver.set_pref("enterprise.felt_tests.is_blocking_shutdown", True)
        self.run_felt_base()
        self.run_felt_browser_started()
        self.check_has_external_link_tab()

        # The queue is only written to disk to survive FELT's own update
        # restart, and it is encrypted when it is. It must never appear while
        # FELT is simply running.
        assert not os.path.exists(urls_file), (
            f"Pending URLs file should not be written outside a restart: {urls_file}"
        )

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

        # Plant the file an attacker with only a file-write primitive could
        # write. It is not valid ciphertext, so it must be discarded rather
        # than opened in the authenticated session.
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
        self._logger.info(f"Planted plaintext pending URLs file: {urls_file}")

        self._driver.start_session(timeout=60)
        self._driver.set_context("chrome")
        self._driver.execute_script(
            """
            console.debug(`Felt: Test: started new FELT`);
            """
        )

        self._logger.info(f"Waiting for planted file to be discarded: {urls_file}")
        self._wait.until(lambda mn: not os.path.exists(urls_file))

        self.run_felt_base()
        self.run_felt_browser_started()

        # Forward a real link and wait for it, so the queue has demonstrably
        # drained before asserting the planted entries never opened.
        self._external_link = f"http://localhost:{self.console_port}/ping"
        self.third_party_open_external_link()
        self.check_has_external_link_tab()

        self.run_no_about_pages()
