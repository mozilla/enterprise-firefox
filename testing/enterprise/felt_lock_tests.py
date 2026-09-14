#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests


class FeltLockTests(FeltTests):
    """Shared setup for the FELT lock-on-close and lock-on-restart suites.

    Both decide lock-vs-signout and inspect FELT-side persisted state, so they
    share keystore stubbing, sign-in, resume-token inspection, and settling.
    Subclasses provide their own _hold_felt_after_child_exit (the restart suite
    additionally forces the update path) plus their own trigger and assertions.
    """

    def _prepare_felt_keystore(self):
        """Stub OSKeyStore on the FELT process and clear any leftover tokens.

        Token encrypt/decrypt otherwise hits the real OS key store (a macOS
        Keychain password prompt), which stalls or fails headless; a reversible
        in-memory transform keeps the round-trip testable. Clearing felt.json
        (shared via UAppData, so it survives the per-test profile) prevents a
        prior test's token from turning this sign-in into an unlock."""
        driver = self.get_driver(Environment.FELT)
        driver.set_context("chrome")
        try:
            driver.execute_script(
                """
                const { OSKeyStore } = ChromeUtils.importESModule(
                    "resource://gre/modules/OSKeyStore.sys.mjs"
                );
                OSKeyStore.encrypt = async plaintext => "enc:" + plaintext;
                OSKeyStore.decrypt = async ciphertext =>
                    String(ciphertext).replace(/^enc:/, "");

                const { FeltStorage } = ChromeUtils.importESModule(
                    "resource://gre/modules/enterprise/FeltStorage.sys.mjs"
                );
                if (FeltStorage._feltStorage?.data) {
                    FeltStorage._feltStorage.data.lockingTokens = {};
                }
                """
            )
        finally:
            driver.set_context("content")

    def _felt_has_locking_token(self):
        """Whether FELT persisted an encrypted resume token for the signed-in user.

        Uses the synchronous hasLockingToken: getLockingToken is async and would
        return an always-truthy Promise through execute_script."""
        driver = self.get_driver(Environment.FELT)
        driver.set_context("chrome")
        try:
            return driver.execute_script(
                """
                const { FeltStorage } = ChromeUtils.importESModule(
                    "resource://gre/modules/enterprise/FeltStorage.sys.mjs"
                );
                const email = FeltStorage.getLastSignedInUser();
                return !!(email && FeltStorage.hasLockingToken(email));
                """
            )
        finally:
            driver.set_context("content")

    def _set_locking_pref(self, pref, enabled):
        """The enterprise.locking.* prefs ship locked in firefox.js; Marionette
        can't override a locked pref the way the policy engine does (it unlocks
        first), so unlock it here to emulate the policy-applied value. Setting
        the pref fires the EnterpriseHandler observer, which syncs the lock
        intent to the browser's FELT IPC client."""
        with self._child_driver.using_context("chrome"):
            self._child_driver.execute_script(
                """
                const pref = arguments[0];
                Services.prefs.unlockPref(pref);
                Services.prefs.setBoolPref(pref, arguments[1]);
                """,
                script_args=(pref, enabled),
            )

    def _settle_after_child_exit(self, browser_pid):
        self.wait_process_exit(browser_pid)
        self.await_felt_auth_window()
        self.force_window()

    def _start_signed_in(self):
        self._hold_felt_after_child_exit()
        self.run_felt_base()
        self._prepare_felt_keystore()
        self.connect_child_browser()
        self.assert_user_signed_in(env=Environment.FIREFOX)
        return self._child_driver.session_capabilities["moz:processID"]
