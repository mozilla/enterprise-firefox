#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

import psutil

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests
from marionette_driver.errors import NoSuchWindowException, UnknownException


class FeltIpcDisconnect(FeltTests):
    def setup(self):
        super().setup()
        self._manually_closed_child = True
        self._browser_process = None

    def teardown(self):
        try:
            if self._browser_process is not None:
                try:
                    self._browser_process.kill()
                    self._browser_process.wait(timeout=30)
                except psutil.NoSuchProcess:
                    pass
        finally:
            super().teardown()

    def _track_browser(self, pid):
        self._browser_process = psutil.Process(pid)
        return pid

    def _kill_felt_and_wait_for_browser_exit(self, app_pid):
        parent_pid = self._driver.session_capabilities["moz:processID"]
        self._driver.delete_session(send_request=False)
        # Kill only FELT, so terminating its process tree cannot make the test pass.
        psutil.Process(parent_pid).kill()
        self.wait_process_exit(app_pid)

    def test_disconnect_after_startup(self):
        # Launches FELT with a stored session and waits until the browser is
        # connected over Marionette and signed in.
        app_pid = self._track_browser(self._start_signed_in())
        self._kill_felt_and_wait_for_browser_exit(app_pid)

    def test_disconnect_before_startup_ready(self):
        self._hold_felt_after_child_exit()
        self._prepare_felt_keystore()
        # Stall FELT after prefs are sent so Ready is never sent and the browser
        # stays blocked in its startup wait; publish the browser pid in a FELT
        # pref so the test can find it.
        with self._driver.using_context("chrome"):
            self._driver.execute_script(
                """
                const { FeltProcessParent } = ChromeUtils.importESModule(
                  "chrome://felt/content/FeltProcessParent.sys.mjs"
                );
                const prototype = FeltProcessParent.prototype;
                const awaitPid = prototype._awaitAnnouncedBrowserPid;
                prototype._awaitAnnouncedBrowserPid = async function(...args) {
                  this.testBrowserPid = await awaitPid.apply(this, args);
                  return this.testBrowserPid;
                };
                const sendPrefs = prototype.sendPrefsToFirefox;
                prototype.sendPrefsToFirefox = async function() {
                  await sendPrefs.call(this);
                  Services.prefs.setStringPref(
                    "enterprise.felt_tests.ipc_startup_app_pid",
                    String(this.testBrowserPid || this.proc.pid)
                  );
                  await new Promise(() => {});
                };
                """
            )

        self.run_felt_base()
        app_pid = self._longwait.until(
            lambda driver: driver.get_pref(
                "enterprise.felt_tests.ipc_startup_app_pid"
            ),
            message="FELT should pause browser startup before sending Ready",
        )
        app_pid = self._track_browser(int(app_pid))
        self.assertTrue(
            self._browser_process.is_running()
            and self._browser_process.status() != psutil.STATUS_ZOMBIE,
            "The browser should still be waiting for FELT's Ready message",
        )
        self._kill_felt_and_wait_for_browser_exit(app_pid)

    def test_normal_shutdown_keeps_felt_alive(self):
        app_pid = self._track_browser(self._start_signed_in())
        with self._driver.using_context("chrome"):
            self._driver.execute_script(
                """
                const pref = "enterprise.felt_tests.ipc_exit_count";
                Services.prefs.setIntPref(pref, 0);
                Services.obs.addObserver(() => {
                  Services.prefs.setIntPref(pref, Services.prefs.getIntPref(pref) + 1);
                }, "felt-firefox-exiting");
                """
            )

        self._child_driver.set_context("chrome")
        try:
            self._child_driver.execute_script(
                "Services.startup.quit(Ci.nsIAppStartup.eForceQuit);"
            )
        except (OSError, NoSuchWindowException, UnknownException) as exc:
            self._logger.info(f"Browser quit before execute_script returned: {exc}")
        self._wait.until(
            lambda _: self.signout_count.value == 1,
            message="Normal shutdown should sign out rather than restart the browser",
        )
        self._settle_after_child_exit(app_pid)
        self.assertEqual(
            self._driver.get_pref("enterprise.felt_tests.ipc_exit_count"),
            1,
            "Normal shutdown should report exactly one browser exit to FELT",
        )
        self.assert_user_signed_out(env=Environment.FELT)
