#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from marionette_driver.geckoinstance import DesktopInstance, GeckoInstance
from test_felt_browser_signout import BaseBrowserSignout


class HarnessPrefs(BaseBrowserSignout):
    EXTRA_PREFS = {
        "enterprise.felt_tests.harness_sets_pref": True,
    }
    EXTRA_CHILD_PREFS = {
        "enterprise.felt_tests.harness_sets_child_pref": True,
    }

    def _check_prefs(self, driver, expected_prefs, label):
        failures = []
        for pref_name, expected_value in expected_prefs.items():
            actual = driver.get_pref(pref_name)
            if actual != expected_value:
                failures.append(
                    f"  {pref_name}: expected {expected_value!r}, got {actual!r}"
                )
        assert not failures, f"[{label}] Pref mismatches:\n" + "\n".join(failures)

    def _check_env(self, expected, excluded):
        failures = []
        with self._driver.using_context("chrome"):
            for key, value in expected.items():
                actual = self._driver.execute_script(
                    """
                    const env = Cc["@mozilla.org/process/environment;1"].getService(Ci.nsIEnvironment);
                    return env.get(arguments[0]);
                    """,
                    script_args=[key],
                )
                if actual != value:
                    failures.append(f"  {key}: expected {value!r}, got {actual!r}")
            for key in excluded:
                exists = self._driver.execute_script(
                    """
                    const env = Cc["@mozilla.org/process/environment;1"].getService(Ci.nsIEnvironment);
                    return env.exists(arguments[0]);
                    """,
                    script_args=[key],
                )
                if exists:
                    failures.append(f"  {key}: expected absent in Firefox process")
        assert not failures, "Env mismatches:\n" + "\n".join(failures)

    def run_check_felt_prefs(self):
        self._check_prefs(self._driver, self._extra_prefs, "FELT UI")
        self._check_env(
            getattr(self, "EXTRA_ENV", {}),
            getattr(self, "EXCLUDED_ENV", set()),
        )

    def run_check_child_prefs(self):
        # EnterpriseEndpoints.init() sets and locks these prefs on the default branch,
        # pointing them at the enterprise console. Mirror RELATIVE_CONSOLE_ENDPOINT_PREFS
        # and BASE_CONSOLE_URI_PREFS from EnterpriseEndpoints.sys.mjs.
        base = f"http://localhost:{self.console_port}/"
        enterprise_prefs = {
            "identity.fxaccounts.remote.oauth.uri": f"{base}api/fxa/oauth/v1",
            "identity.fxaccounts.remote.profile.uri": f"{base}api/fxa/profile/v1",
            "identity.fxaccounts.auth.uri": f"{base}api/fxa/api/v1",
            "security.certerrors.mitm.priming.endpoint": f"{base}api/misc/mitm/",
            "captivedetect.canonicalURL": f"{base}api/misc/portal/canonical.html",
            "network.connectivity-service.IPv4.url": f"{base}api/misc/connectivity?ipv4",
            "network.connectivity-service.IPv6.url": f"{base}api/misc/connectivity?ipv6",
            "browser.ipProtection.guardian.endpoint": base,
            "identity.fxaccounts.remote.root": base,
        }

        gecko_prefs = {
            k: v
            for k, v in GeckoInstance.required_prefs.items()
            # Drop prefs with %-style format placeholders (e.g. "%(server)s")
            # as they require interpolation that isn't performed here.
            if (not isinstance(v, str) or "%" not in v) and k not in enterprise_prefs
        }
        child_prefs = {
            **gecko_prefs,
            **DesktopInstance.desktop_prefs,
            **enterprise_prefs,
            # services.settings.server is set to "" by FELT via FeltProcessParent,
            # which forwards remote_settings_url from the console Firefox configuration.
            "services.settings.server": "",
            "enterprise.is_testing": True,
            **self.EXTRA_CHILD_PREFS,
        }
        self._check_prefs(self._child_driver, child_prefs, "child browser")


class HarnessPrefsTest(HarnessPrefs):
    # Verifies that prefs and environment variables set by the harness are
    # correctly propagated to both the FELT UI browser and the child browser.
    # Three sequential tests each inject a distinct environment variable so
    # that the "no_leakage" tests can also assert that env vars from earlier
    # test runs are absent, catching any cross-test contamination.
    _ENV_BY_TEST = {
        "test_1_harness_prefs": {"ENTERPRISE_HARNESS_TEST_1": "first"},
        "test_2_harness_prefs_no_leakage": {"ENTERPRISE_HARNESS_TEST_2": "second"},
        "test_3_harness_prefs_no_leakage": {"ENTERPRISE_HARNESS_TEST_3": "third"},
    }

    def setUp(self):
        # Inject the env var for this test and exclude all env vars from other
        # tests, so run_check_felt_prefs can assert presence and absence.
        self.EXTRA_ENV = self._ENV_BY_TEST.get(self._testMethodName, {})
        self.EXCLUDED_ENV = {
            key
            for test_name, env in self._ENV_BY_TEST.items()
            if test_name != self._testMethodName
            for key in env
        }
        super().setUp()

    def _run(self):
        self.run_felt_chrome_on_email_submit()
        self.run_check_felt_prefs()
        self.run_wait_until_sso_loaded()
        self.run_felt_perform_sso_auth()
        self.connect_child_browser(capabilities={"unhandledPromptBehavior": "ignore"})
        self.run_check_child_prefs()
        self._do_signout()

    def test_1_harness_prefs(self):
        self._run()

    def test_2_harness_prefs_no_leakage(self):
        self._run()

    def test_3_harness_prefs_no_leakage(self):
        self._run()
