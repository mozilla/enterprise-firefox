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
    # Marionette runs each test_* method through its own setUp()/tearDown()
    # cycle, which starts a new session each time. We count session starts to
    # verify sequential execution (e.g., test_4 expects exactly 4 starts).
    # Subclasses that need cumulative restart tracking must define
    # start_session_count = 0 to get their own independent counter.
    start_session_count = 0

    def setUp(self):
        marionette = self._marionette_weakref()
        self._original_start_session = marionette.start_session

        def counting_start_session(*args, **kwargs):
            type(self).start_session_count += 1
            return self._original_start_session(*args, **kwargs)

        marionette.start_session = counting_start_session

        super().setUp()

        self._manually_closed_child = True

    def tearDown(self):
        super().tearDown()
        self.marionette.start_session = self._original_start_session

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
                    failures.append(f"  {key}: expected absent in FELT process")
        assert not failures, "Env mismatches:\n" + "\n".join(failures)

    def _check_prefs_absent(self, driver, excluded_prefs, label):
        failures = []
        for pref_name in excluded_prefs:
            actual = driver.get_pref(pref_name)
            if actual is not None:
                failures.append(f"  {pref_name}: expected absent, got {actual!r}")
        assert not failures, f"[{label}] Prefs should be absent:\n" + "\n".join(
            failures
        )

    def _build_common_prefs(self):
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
            "enterprise.is_testing": True,
            "enterprise.log_level": "Debug",
        }
        gecko_prefs = {
            k: v
            for k, v in {
                **GeckoInstance.required_prefs,
                **DesktopInstance.desktop_prefs,
            }.items()
            # Drop prefs with %-style format placeholders (e.g. "%(server)s")
            # as they require interpolation that isn't performed here.
            if (not isinstance(v, str) or "%" not in v) and k not in enterprise_prefs
        }
        return enterprise_prefs, gecko_prefs

    def run_check_felt_set_prefs_absent_prefs_and_env(self):
        enterprise_prefs, gecko_prefs = self._build_common_prefs()
        felt_prefs = {
            **gecko_prefs,
            **enterprise_prefs,
            **self._extra_prefs,
        }
        self._check_prefs(self._driver, felt_prefs, "FELT UI")
        self._check_prefs_absent(
            self._driver, getattr(self, "EXCLUDED_PREFS", set()), "FELT UI"
        )
        self._check_env(
            getattr(self, "EXTRA_ENV", {}),
            getattr(self, "EXCLUDED_ENV", set()),
        )

    def run_check_child_prefs(self):
        enterprise_prefs, gecko_prefs = self._build_common_prefs()
        child_prefs = {
            **gecko_prefs,
            **enterprise_prefs,
            # services.settings.server is set to "" by FELT via FeltProcessParent,
            # which forwards remote_settings_url from the console Firefox configuration.
            "services.settings.server": "",
            **self.EXTRA_CHILD_PREFS,
        }
        self._check_prefs(self._child_driver, child_prefs, "child browser")


class HarnessPrefsFirstTestNoCliArgsTest(HarnessPrefs):
    # Verifies that when the first test has no EXTRA_ENV and no _extra_cli_args,
    # only one start_session happens (ideally it should be 0, but unavoidable).
    EXTRA_ENV = {}
    EXTRA_PREFS = {}
    start_session_count = 0

    def test_no_extra_env_no_restart(self):
        assert HarnessPrefsFirstTestNoCliArgsTest.start_session_count == 1, (
            f"Expected 1 session starts, got {HarnessPrefsFirstTestNoCliArgsTest.start_session_count}"
        )


class HarnessPrefsNoEnvSubsequentTest(HarnessPrefs):
    # Verifies that subsequent tests without EXTRA_ENV cost 1 start_session calls each.
    EXTRA_ENV = {}
    EXTRA_PREFS = {}
    start_session_count = 0

    def test_1_no_env(self):
        assert HarnessPrefsNoEnvSubsequentTest.start_session_count == 1, (
            f"Expected 1 session starts, got {HarnessPrefsNoEnvSubsequentTest.start_session_count}"
        )

    def test_2_no_env(self):
        assert HarnessPrefsNoEnvSubsequentTest.start_session_count == 2, (
            f"Expected 2 session starts, got {HarnessPrefsNoEnvSubsequentTest.start_session_count}"
        )


class HarnessPrefsFirstTestWithCliArgsTest(HarnessPrefs):
    # Verifies that a truthy _extra_cli_args triggers only 1 session start per test
    EXTRA_ENV = {}
    EXTRA_PREFS = {}
    start_session_count = 0

    def setUp(self):
        self._extra_cli_args = ["--test"]
        super().setUp()

    def test_cli_args_triggers_restart(self):
        assert HarnessPrefsFirstTestWithCliArgsTest.start_session_count == 1, (
            f"Expected 1 session start, got {HarnessPrefsFirstTestWithCliArgsTest.start_session_count}"
        )


class HarnessPrefsTest(HarnessPrefs):
    EXTRA_ENV = {
        "MOZ_ENTERPRISE_HARNESS_ENV_TEST": "1",
    }
    EXTRA_PREFS = {
        "enterprise.felt_tests.harness_sets_pref": True,
    }
    EXTRA_CHILD_PREFS = {
        "enterprise.felt_tests.harness_sets_child_pref": True,
    }

    # Verifies that prefs and environment variables set by the harness are
    # correctly propagated to both the FELT UI browser and the child browser.
    # Four sequential tests each inject a distinct environment variable so
    # that the "no_leakage" tests can also assert that env vars from earlier
    # test runs are absent, catching any cross-test contamination.
    # harness_sets_pref_value uses the same pref name across all tests but a
    # different value each time, verifying that same-name prefs don't leak.
    _ENV_BY_TEST = {
        "test_1_harness_prefs": {
            "ENTERPRISE_HARNESS_TEST_1": "first",
            "ENTERPRISE_HARNESS_TEST_VALUE": "first",
        },
        "test_2_harness_prefs_no_leakage": {
            "ENTERPRISE_HARNESS_TEST_2": "second",
            "ENTERPRISE_HARNESS_TEST_VALUE": "second",
        },
        "test_3_harness_prefs_no_leakage": {
            "ENTERPRISE_HARNESS_TEST_3": "third",
            "ENTERPRISE_HARNESS_TEST_VALUE": "third",
        },
        "test_4_harness_prefs_no_leakage": {
            "ENTERPRISE_HARNESS_TEST_4": "fourth",
            "ENTERPRISE_HARNESS_TEST_VALUE": "fourth",
        },
    }
    _PREFS_BY_TEST = {
        "test_1_harness_prefs": {
            "enterprise.felt_tests.harness_sets_pref_1": True,
            "enterprise.felt_tests.harness_sets_pref_value": 1,
        },
        "test_2_harness_prefs_no_leakage": {
            "enterprise.felt_tests.harness_sets_pref_2": True,
            "enterprise.felt_tests.harness_sets_pref_value": 2,
        },
        "test_3_harness_prefs_no_leakage": {
            "enterprise.felt_tests.harness_sets_pref_3": True,
            "enterprise.felt_tests.harness_sets_pref_value": 3,
        },
        "test_4_harness_prefs_no_leakage": {
            "enterprise.felt_tests.harness_sets_pref_4": True,
            "enterprise.felt_tests.harness_sets_pref_value": 4,
        },
    }

    start_session_count = 0

    @staticmethod
    def _merge_and_exclude(base, by_test, test_name):
        merged = {**base, **by_test.get(test_name, {})}
        excluded = {
            key
            for name, items in by_test.items()
            if name != test_name
            for key in items
            if key not in merged
        }
        return merged, excluded

    def setUp(self):
        self.EXTRA_ENV, self.EXCLUDED_ENV = self._merge_and_exclude(
            HarnessPrefsTest.EXTRA_ENV, self._ENV_BY_TEST, self._testMethodName
        )
        self.EXTRA_PREFS, self.EXCLUDED_PREFS = self._merge_and_exclude(
            HarnessPrefsTest.EXTRA_PREFS, self._PREFS_BY_TEST, self._testMethodName
        )

        assert not (self.EXTRA_ENV.keys() & self.EXCLUDED_ENV)
        assert not (self.EXTRA_PREFS.keys() & self.EXCLUDED_PREFS)

        super().setUp()

    def _run(self):
        self.run_felt_chrome_on_email_submit()
        self.run_check_felt_set_prefs_absent_prefs_and_env()
        self.run_wait_until_sso_loaded()
        self.run_felt_perform_sso_auth()
        self.connect_child_browser(capabilities={"unhandledPromptBehavior": "ignore"})
        self.run_check_child_prefs()
        self._do_signout()

    # Each test triggers a setUp()/tearDown() cycle, incrementing
    # start_session_count by one. The cumulative count confirms that
    # tests run in order and each gets exactly one new session.

    def test_1_harness_prefs(self):
        self._run()
        assert HarnessPrefsTest.start_session_count == 1, (
            f"Expected 1 session start, got {HarnessPrefsTest.start_session_count}"
        )

    def test_2_harness_prefs_no_leakage(self):
        self._run()
        assert HarnessPrefsTest.start_session_count == 2, (
            f"Expected 2 session starts, got {HarnessPrefsTest.start_session_count}"
        )

    def test_3_harness_prefs_no_leakage(self):
        self._run()
        assert HarnessPrefsTest.start_session_count == 3, (
            f"Expected 3 session starts, got {HarnessPrefsTest.start_session_count}"
        )

    def test_4_harness_prefs_no_leakage(self):
        self._run()
        assert HarnessPrefsTest.start_session_count == 4, (
            f"Expected 4 session starts, got {HarnessPrefsTest.start_session_count}"
        )
