#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import json
import os
import sys
import time

sys.path.append(os.path.dirname(__file__))

from felt_external_link import BaseBrowserExternalLink


class FeltStartsBrowserExternalLink(BaseBrowserExternalLink):
    def felt_json_path(self):
        self._driver.set_context("chrome")
        return self._driver.execute_script(
            "return ChromeUtils.importESModule('moz-src:///toolkit/components/felt/FeltStorage.sys.mjs').FeltStorage.FELT_FILE_PATH;"
        )

    def has_stored_queue(self, felt_json):
        """Whether felt.json holds a stored queue for the next launch. Read from the
        file rather than the running FELT, which has no window to script once
        the browser has taken over."""
        if not os.path.exists(felt_json):
            return False
        with open(felt_json) as stored:
            return "pendingURLs" in json.loads(stored.read())

    def pending_urls(self):
        """The queue as the launch sees it, once anything stored is restored."""
        self._driver.set_context("chrome")
        return self._driver.execute_async_script(
            """
            const callback = arguments[arguments.length - 1];
            const { gFeltPendingURLs } = ChromeUtils.importESModule('moz-src:///browser/components/FeltURLHandler.sys.mjs');
            gFeltPendingURLs.init().then(() => callback([...gFeltPendingURLs]));
            """
        )

    def wait_for_one_pending_url(self):
        self._driver.set_context("chrome")
        self._wait.until(
            lambda mn: mn.execute_script(
                "return ChromeUtils.importESModule('moz-src:///browser/components/FeltURLHandler.sys.mjs').gFeltPendingURLs.length === 1;"
            )
        )

    def test_browser_external_link(self):
        self.run_felt_base()
        self._external_link = f"http://localhost:{self.console_port}/ping"
        self.run_felt_browser_started()
        self.run_felt_open_external_link()

    def test_pending_external_link_survives_restart(self):
        felt_json = self.felt_json_path()
        self._external_link = f"http://localhost:{self.console_port}/ping"
        with self.stub_felt_keystore_on_launch():
            with self.stub_felt_keystore():
                self.third_party_open_external_link()
                self.wait_for_one_pending_url()
                self._logger.info("Waiting for the queued URL to be stored")
                self._wait.until(lambda _: self.has_stored_queue(felt_json))

            self._driver.restart(in_app=True)

        restored = self.pending_urls()
        assert [entry["url"] for entry in restored] == [self._external_link], (
            f"The restart should have carried {self._external_link}"
        )

        self.run_felt_base()
        self.run_felt_browser_started()
        self.check_has_external_link_tab()

        self._logger.info("Waiting for the forwarded URL to stop being stored")
        self._wait.until(lambda _: not self.has_stored_queue(felt_json))

    def test_pending_external_link_does_not_survive_a_cold_start(self):
        felt_json = self.felt_json_path()
        self._external_link = "https://example.com/cold-start"
        with self.stub_felt_keystore():
            self.third_party_open_external_link()
            self.wait_for_one_pending_url()
            self._wait.until(lambda _: self.has_stored_queue(felt_json))

        # A plain quit is not a restart, so the stored queue must be discarded.
        self._driver.quit(in_app=True, clean=False)
        self._driver.start_session(timeout=60)

        # pending_urls() waits for the launch to finish restoring, which is also
        # when a cold start drops the stored copy.
        assert self.pending_urls() == [], "A cold start must not restore queued URLs"
        assert not self.has_stored_queue(felt_json), (
            "A quit that is not a restart must not leave a stored queue"
        )
        self.run_felt_base()
        self.run_felt_browser_started()
        self.check_no_external_link_tab()

    def test_browser_pending_external_link(self):
        self._external_link = f"http://localhost:{self.console_port}/ping?pending"
        felt_json = self.felt_json_path()

        assert not self.has_stored_queue(felt_json), (
            "The test must begin with nothing stored"
        )
        with self.stub_felt_keystore():
            self.third_party_open_external_link()
            self._wait.until(lambda _: self.has_stored_queue(felt_json))

        self._driver.set_pref("enterprise.felt_tests.is_blocking_shutdown", True)
        self.run_felt_base()
        self.run_felt_browser_started()
        self.check_has_external_link_tab()

        # The stored copy mirrors the queue, so forwarding the URLs drops it.
        self._wait.until(lambda _: not self.has_stored_queue(felt_json))

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

        # Plant the stored queue an attacker with only a file-write primitive could
        # write. The relaunch below is not a restart, so it is discarded unread;
        # test_felt_pending_urls.js covers rejecting it on a restart too.
        with open(felt_json) as stored:
            data = json.loads(stored.read())
        planted = [
            f"http://localhost:{self.console_port}/ping?planted-1",
            f"http://localhost:{self.console_port}/ping?planted-2",
        ]
        data["pendingURLs"] = {
            "version": 1,
            "createdAt": int(time.time() * 1000),
            "ciphertext": json.dumps([
                {"url": url, "disposition": 0} for url in planted
            ]),
        }
        with open(felt_json, "w") as stored:
            stored.write(json.dumps(data))
        self._logger.info(f"Planted an unencrypted queue in {felt_json}")

        self._driver.start_session(timeout=60)
        self._driver.set_context("chrome")
        self._driver.execute_script(
            """
            console.debug(`Felt: Test: started new FELT`);
            """
        )

        self._logger.info("Waiting for the planted queue to be discarded")
        self._wait.until(lambda _: not self.has_stored_queue(felt_json))

        self.run_felt_base()
        self.run_felt_browser_started()

        # Forward a real link and wait for it, so the queue has demonstrably
        # drained before asserting the planted entries never opened.
        self._external_link = f"http://localhost:{self.console_port}/ping"
        self.third_party_open_external_link()
        self.check_has_external_link_tab()

        self.check_planted_urls_not_opened(planted)
