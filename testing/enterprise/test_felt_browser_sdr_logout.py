#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class FeltBrowserSdrLogout(FeltTests):
    """Bug 2021342: in the console-provisioned Felt browser the internal NSS
    token is unlocked at startup with a secret the user does not know, so
    SecretDecoderRing's ClearData teardown (logoutAndTeardown) must NOT log the
    token out -- otherwise later SDR use would prompt for that secret. Only an
    explicit logout() should log out. The guard is gated on is_felt_browser(),
    so it is only observable in the real Felt browser (never under xpcshell,
    where felt_init() does not run)."""

    def _child_chrome_async(self, body):
        self._child_driver.set_context("chrome")
        try:
            return self._child_driver.execute_async_script(
                "const resolve = arguments[arguments.length - 1];\n"
                "(async () => {\n" + body + "\n})()"
                ".then(resolve, e => resolve({ _error: String(e) }));"
            )
        finally:
            self._child_driver.set_context("content")

    def test_logout_and_teardown_keeps_managed_token_unlocked(self):
        self.run_felt_base()
        self.connect_child_browser()

        result = self._child_chrome_async(
            """
            const { setTimeout } = ChromeUtils.importESModule(
              "resource://gre/modules/Timer.sys.mjs");
            const token = Cc["@mozilla.org/security/internalkeytoken;1"]
              .createInstance(Ci.nsIPKCS11Token);

            // EnterpriseStorageEncryption.load() unlocks the token
            // asynchronously at startup; wait for it before exercising the
            // teardown guard.
            const deadline = Date.now() + 20000;
            while (Date.now() < deadline && !token.isLoggedIn) {
              await new Promise(r => setTimeout(r, 250));
            }

            const sdr = Cc["@mozilla.org/security/sdr;1"]
              .getService(Ci.nsISecretDecoderRing);
            const unlocked = token.isLoggedIn;
            sdr.logoutAndTeardown();
            const afterTeardown = token.isLoggedIn;
            sdr.logout();
            const afterLogout = token.isLoggedIn;

            return {
              isFeltBrowser: !!Services.felt?.isFeltBrowser(),
              unlocked,
              afterTeardown,
              afterLogout,
            };
            """
        )

        assert result.get("_error") is None, result
        assert result["isFeltBrowser"], f"child should be a Felt browser; {result}"
        assert result["unlocked"], (
            f"token should be unlocked at startup by "
            f"EnterpriseStorageEncryption; {result}"
        )
        assert result["afterTeardown"], (
            f"managed token must stay logged in through logoutAndTeardown "
            f"(Bug 2021342); {result}"
        )
        assert not result["afterLogout"], (
            f"explicit logout() should still log the token out; {result}"
        )
