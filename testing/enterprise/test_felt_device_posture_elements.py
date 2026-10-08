#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import json
import os
import sys

sys.path.append(os.path.dirname(__file__))

import requests
from base_test import Environment
from felt_tests import FeltTests


class FeltDevicePostureElements(FeltTests):
    """The console drives which EDR agents device posture probes.

    The console publishes one global `edr_agents` list in the posture
    configuration it returns with the SSO callback and with every token response;
    Felt stores it into the enterprise.posture.* prefs, and DevicePosture.collect
    probes exactly that list on every platform, probing nothing when the prefs are
    unset.
    """

    EDR_AGENTS = ["crowdstrike", "cortex-xdr", "sentinelone"]

    # A second descriptor, to check that a descriptor arriving mid-session
    # replaces the one the browser was launched with.
    UPDATED_EDR_AGENTS = ["sentinelone", "cortex-xdr"]

    def test_posture_elements(self):
        # The posture configuration comes back with the SSO callback, so the
        # console must serve edr_agents before run_felt_base().
        self.posture_edr_agents.value = json.dumps(
            self.EDR_AGENTS, separators=(",", ":")
        )
        # Felt collects posture for sign-in, and has no window to script once
        # the browser is up, so check its collection path first.
        self.run_build_and_security_sections("felt", self._driver)
        super().run_felt_base()
        self.connect_child_browser()

        self.run_os_version_not_sent_to_sso()
        self.run_config_pref_plumbing()
        self.run_console_driven_probes()
        self.run_probe_none_when_unconfigured()
        self.run_build_and_security_sections("browser", self._child_driver)
        # Runs last: it replaces the descriptor the console serves.
        self.run_mid_session_descriptor_reaches_browser()

    def run_os_version_not_sent_to_sso(self):
        """The login request identifies only the user and the device."""
        console_addr = f"http://localhost:{self.console_port}"
        r = requests.get(f"{console_addr}/sso/get_sso_os_version")
        os_version = r.json()
        assert os_version is None, (
            f"SSO login must not carry an osVersion, got {os_version!r}"
        )

    def _wait_for_string_pref(self, name):
        # The value comes from the console's posture configuration, which Felt
        # pushes over IPC, so it lands some time after the browser is up.
        self._child_driver.set_context("chrome")
        try:
            return self._child_wait.until(
                lambda _: self._child_driver.execute_script(
                    f"return Services.prefs.getStringPref('{name}', '') || null;"
                )
            )
        finally:
            self._child_driver.set_context("content")

    def run_config_pref_plumbing(self):
        """The complete edr_agents list is pushed to the browser as a JSON pref."""
        edr_pref = self._wait_for_string_pref("enterprise.posture.edr_agents")
        assert json.loads(edr_pref) == self.EDR_AGENTS, (
            "edr_agents pref reflects the complete list from the console posture "
            f"configuration, got {edr_pref}"
        )

    def run_console_driven_probes(self):
        """DevicePosture.collect probes exactly the console-configured EDR list."""
        self._child_driver.set_context("chrome")
        try:
            collected_edrs = self._child_driver.execute_async_script(
                """
                const callback = arguments[arguments.length - 1];
                const edrMod = ChromeUtils.importESModule(
                  "resource://gre/modules/enterprise/EdrDetection.sys.mjs"
                );
                const { DevicePosture } = ChromeUtils.importESModule(
                  "resource://gre/modules/enterprise/DevicePosture.sys.mjs"
                );
                // Spy on getPresentEdrs so we can assert which agents were
                // requested without depending on what is installed on the host.
                const original = edrMod.EdrDetection.getPresentEdrs;
                let recorded = null;
                edrMod.EdrDetection.getPresentEdrs = ids => {
                  recorded = ids;
                  return Promise.resolve([]);
                };
                DevicePosture.collect()
                  .then(posture => {
                    edrMod.EdrDetection.getPresentEdrs = original;
                    callback({
                      recorded,
                      presentEdrs: posture.presentEdrs,
                    });
                  })
                  .catch(err => {
                    edrMod.EdrDetection.getPresentEdrs = original;
                    callback({ _error: String(err) });
                  });
                """
            )
        finally:
            self._child_driver.set_context("content")

        assert "_error" not in collected_edrs, (
            f"DevicePosture.collect threw: {collected_edrs.get('_error')}"
        )
        assert collected_edrs["recorded"] == self.EDR_AGENTS, (
            "getPresentEdrs called with the complete console-configured list, "
            f"got {collected_edrs['recorded']}"
        )

    def run_probe_none_when_unconfigured(self):
        """With no EDR configured, getPresentEdrs is never called (an empty list
        would otherwise mean 'probe every known agent')."""
        # Both an explicit empty list and an absent/cleared pref must probe none.
        for edr_pref_value in ["[]", None]:
            rv = self._collect_with_edr_spy(edr_pref_value)
            assert "_error" not in rv, (
                f"DevicePosture.collect threw: {rv.get('_error')}"
            )
            assert rv["called"] is False, (
                "getPresentEdrs must not be called when no EDR is configured "
                f"(edr_agents={edr_pref_value!r})"
            )
            assert rv["presentEdrs"] == [], (
                f"presentEdrs is empty when no EDR configured, got {rv['presentEdrs']}"
            )

    def run_build_and_security_sections(self, label, driver):
        """The build, security and os sections are populated in the process
        behind driver."""
        driver.set_context("chrome")
        try:
            rv = driver.execute_async_script(
                """
                const callback = arguments[arguments.length - 1];
                const { DevicePosture } = ChromeUtils.importESModule(
                  "resource://gre/modules/enterprise/DevicePosture.sys.mjs"
                );
                const { AppConstants } = ChromeUtils.importESModule(
                  "resource://gre/modules/AppConstants.sys.mjs"
                );
                DevicePosture.collect().then(
                  ({ build, security, os }) =>
                    callback({
                      build,
                      security,
                      os,
                      isWindows: AppConstants.platform == "win",
                      appVersion: Services.appinfo.version,
                    }),
                  err => callback({ _error: String(err) })
                );
                """
            )
        finally:
            driver.set_context("content")

        assert "_error" not in rv, (
            f"[{label}] DevicePosture.collect threw: {rv.get('_error')}"
        )
        for field in (
            "applicationId",
            "applicationName",
            "version",
            "vendor",
            "displayVersion",
            "platformVersion",
            "buildId",
            "architecture",
            "xpcomAbi",
        ):
            assert rv["build"].get(field), f"[{label}] build.{field} is empty"
        assert rv["build"]["version"] == rv["appVersion"], (
            f"[{label}] build.version is {rv['build']['version']!r}, "
            f"appinfo has {rv['appVersion']!r}"
        )
        assert isinstance(rv["build"].get("updaterAvailable"), bool), (
            f"[{label}] build.updaterAvailable is not a boolean"
        )
        assert set(rv["security"]) == {"antivirus", "antispyware", "firewall"}, (
            f"[{label}] security is {rv['security']!r}"
        )
        for field in ("name", "version", "locale"):
            assert rv["os"].get(field), f"[{label}] os.{field} is empty"
        if rv["isWindows"]:
            # Null when the registry or OS info collection has nothing, so only
            # the presence of the keys is checked.
            for field in (
                "windowsBuildNumber",
                "windowsUBR",
                "installYear",
                "hasPrefetch",
                "hasSuperfetch",
            ):
                assert field in rv["os"], f"[{label}] os.{field} is missing"

    def run_mid_session_descriptor_reaches_browser(self):
        """A descriptor delivered after the browser started reaches it too, so
        both processes collect posture from the same probe list."""
        expected = self.UPDATED_EDR_AGENTS
        self.posture_edr_agents.value = json.dumps(
            self.UPDATED_EDR_AGENTS, separators=(",", ":")
        )

        # Have the browser ask Felt for a token refresh: the console folds the
        # descriptor it currently serves into that response. A refresh that was
        # already in flight carries the previous descriptor, so keep asking
        # (every 10th poll, to leave each attempt time to complete). The test
        # drives the refresh itself rather than waiting for the policy poll.
        polls = 0

        def refreshed(_):
            nonlocal polls
            if polls % 10 == 0:
                self._child_driver.execute_script("Services.felt.refreshTokens();")
            polls += 1
            value = self._child_driver.execute_script(
                "return Services.prefs.getStringPref("
                "'enterprise.posture.edr_agents', '');"
            )
            return value if value and json.loads(value) == expected else None

        self._child_driver.set_context("chrome")
        try:
            edr_pref = self._child_wait.until(refreshed)
        finally:
            self._child_driver.set_context("content")

        assert json.loads(edr_pref) == expected, (
            "the mid-session descriptor replaced the launch-time probe list, got "
            f"{edr_pref}"
        )

    def test_profile_derivation_from_user_id(self):
        """A distinct user id derives a stable, per-user managed profile name;
        the same id derives the same name (so getProfilePath reuses one profile)
        and a missing id falls back to the shared base.

        Every other test pins enterprise.profile_path, which bypasses this
        derivation entirely. We test the pure getProfileName mapping directly to
        avoid getProfilePath's profile-creation side effect on the real profile
        registry.
        """
        # FELT-only test: getProfileName lives in chrome://felt, so run against
        # the login-window chrome context that setUp already established. We do
        # not log in and never launch a child browser, so tell teardown not to
        # expect one.
        self._manually_closed_child = True
        rv = self._derive_profile_names(["felt-user-one", "felt-user-two"])
        assert "_error" not in rv, f"getProfileName threw: {rv.get('_error')}"

        base, first_user, second_user, first_user_again, fallback = (
            rv["base"],
            rv["firstUser"],
            rv["secondUser"],
            rv["firstUserAgain"],
            rv["fallback"],
        )
        assert first_user and second_user, "derivation returned profile names"
        assert first_user.startswith(f"{base}-"), (
            f"derived profile name is under the shared base, got {first_user}"
        )
        assert second_user.startswith(f"{base}-"), (
            f"derived profile name is under the shared base, got {second_user}"
        )
        assert first_user != base, "a user id must derive more than the bare base name"
        assert first_user != second_user, "distinct user ids derive distinct profiles"
        assert first_user == first_user_again, (
            "the same user id derives the same profile"
        )
        assert fallback == base, "a missing user id falls back to the shared base"

    def _derive_profile_names(self, user_ids):
        self._driver.set_context("chrome")
        try:
            return self._driver.execute_async_script(
                """
                const [firstUserId, secondUserId] = arguments[0];
                const callback = arguments[arguments.length - 1];
                (async () => {
                  const { getProfileName } = ChromeUtils.importESModule(
                    "chrome://felt/content/FeltCommon.sys.mjs"
                  );
                  const { AppConstants } = ChromeUtils.importESModule(
                    "resource://gre/modules/AppConstants.sys.mjs"
                  );
                  return {
                    firstUser: await getProfileName(firstUserId),
                    secondUser: await getProfileName(secondUserId),
                    firstUserAgain: await getProfileName(firstUserId),
                    fallback: await getProfileName(null),
                    base: `enterprise-profile-${AppConstants.MOZ_UPDATE_CHANNEL}`,
                  };
                })().then(callback, err => callback({ _error: String(err) }));
                """,
                [user_ids],
            )
        finally:
            self._driver.set_context("content")

    # A minimal on-disk add-on database, in the shape XPIDatabase serializes:
    # an active and a disabled add-on that posture reports, plus an invisible
    # add-on and a type it does not report. The localized names cover each way
    # an add-on can name itself: translated into the reported locale, into a
    # region of it, into a bare language, and not at all.
    ADDON_DB = {
        "schemaVersion": 36,
        "addons": [
            {
                "id": "active@example.com",
                "type": "extension",
                "version": "1.2",
                "visible": True,
                "active": True,
                "location": "app-profile",
                "defaultLocale": {"name": "Active Extension"},
                "locales": [{"locales": ["de"], "name": "Aktive Erweiterung"}],
            },
            {
                "id": "disabled@example.com",
                "type": "extension",
                "version": "0.9",
                "visible": True,
                "active": False,
                "location": "app-profile",
                "defaultLocale": {"name": "Deaktivierte Erweiterung"},
                "locales": [{"locales": ["en-US"], "name": "Disabled Extension"}],
            },
            {
                "id": "multilocale@example.com",
                "type": "extension",
                "version": "2.0",
                "visible": True,
                "active": True,
                "location": "app-profile",
                "defaultLocale": {"name": "Standardname"},
                "locales": [
                    {"locales": ["de"], "name": "Deutscher Name"},
                    {"locales": ["en-US"], "name": "English Name"},
                ],
            },
            {
                "id": "generic-english@example.com",
                "type": "extension",
                "version": "1.1",
                "visible": True,
                "active": True,
                "location": "app-profile",
                "defaultLocale": {"name": "Nombre Predeterminado"},
                "locales": [{"locales": ["en"], "name": "Generic English Name"}],
            },
            {
                "id": "no-english@example.com",
                "type": "extension",
                "version": "4.5",
                "visible": True,
                "active": True,
                "location": "app-profile",
                "defaultLocale": {"name": "Nom Par Defaut"},
                "locales": [{"locales": ["fr", "de"], "name": "Nom Francais"}],
            },
            {
                "id": "builtin@example.com",
                "type": "extension",
                "version": "5.0",
                "visible": True,
                "active": True,
                "location": "app-builtin",
                "defaultLocale": {"name": "Builtin Extension"},
                "locales": [],
            },
            {
                "id": "invisible@example.com",
                "type": "extension",
                "version": "3.0",
                "visible": False,
                "active": True,
                "defaultLocale": {"name": "Invisible Extension"},
                "locales": [],
            },
            {
                "id": "theme@example.com",
                "type": "theme",
                "version": "1.0",
                "visible": True,
                "active": True,
                "defaultLocale": {"name": "A Theme"},
                "locales": [],
            },
        ],
    }

    def test_felt_reads_the_addon_db_without_writing_it(self):
        """Felt reports the launching profile's add-ons from its on-disk database,
        and the read leaves that database byte-identical."""
        # FELT-only test (see test_profile_derivation_from_user_id): getExtensions
        # takes the isFeltUI() on-disk path, so no login/child browser is needed.
        self._manually_closed_child = True
        rv = self._collect_with_addon_db(json.dumps(self.ADDON_DB))
        assert "_error" not in rv, f"DevicePosture.collect threw: {rv.get('_error')}"
        assert isinstance(rv["extensions"], list), (
            f"the add-on list was read, got {rv['extensions']!r}"
        )

        reported = {addon["id"]: addon for addon in rv["extensions"]}
        assert set(reported) == {
            "active@example.com",
            "disabled@example.com",
            "multilocale@example.com",
            "generic-english@example.com",
            "no-english@example.com",
            "builtin@example.com",
        }, (
            "only visible add-ons of a reported type are reported, got "
            f"{sorted(reported)}"
        )
        assert reported["active@example.com"] == {
            "id": "active@example.com",
            "name": "Active Extension",
            "type": "extension",
            "version": "1.2",
            "enabled": True,
        }, (
            "the reported fields match the database, falling back to the add-on's "
            f"default locale, got {reported}"
        )
        assert reported["disabled@example.com"]["enabled"] is False, (
            "an inactive add-on is reported as disabled"
        )
        # Each add-on is reported under its en-US name, or under its default name
        # when it has no en-US one.
        assert {addon_id: addon["name"] for addon_id, addon in reported.items()} == {
            "active@example.com": "Active Extension",
            "disabled@example.com": "Disabled Extension",
            "multilocale@example.com": "English Name",
            "generic-english@example.com": "Generic English Name",
            "no-english@example.com": "Nom Par Defaut",
            "builtin@example.com": "Builtin Extension",
        }, f"reported add-on names, got {reported}"
        self._assert_addon_db_untouched(rv)

    def test_safe_mode_deactivates_the_addons_it_deactivates(self):
        """A browser launched in safe mode runs neither more nor fewer add-ons
        than AddonWrapper.isActive reports there: the stored active bit alone
        would report a profile extension as enabled when safe mode has turned it
        off, while the add-ons safe mode keeps are still enabled."""
        self._manually_closed_child = True
        db = json.dumps(self.ADDON_DB)

        normal = self._read_addons_for_felt(db, safe_mode=False)
        assert {addon["id"]: addon["enabled"] for addon in normal} == {
            "active@example.com": True,
            "disabled@example.com": False,
            "multilocale@example.com": True,
            "generic-english@example.com": True,
            "no-english@example.com": True,
            "builtin@example.com": True,
        }, f"outside safe mode the stored active bit is reported, got {normal}"

        safe = self._read_addons_for_felt(db, safe_mode=True)
        assert {addon["id"]: addon["enabled"] for addon in safe} == {
            # Profile add-ons do not run in safe mode, whatever the database says.
            "active@example.com": False,
            "disabled@example.com": False,
            "multilocale@example.com": False,
            "generic-english@example.com": False,
            "no-english@example.com": False,
            # Built-ins do.
            "builtin@example.com": True,
        }, f"safe mode reports what it actually runs, got {safe}"

    def _read_addons_for_felt(self, extensions_json, safe_mode):
        """Reads a scratch profile's database as a browser launched with, or
        without, safe mode. The Felt process decides that from its own command
        line, which a test cannot vary, so it is passed in here."""
        self._driver.set_context("chrome")
        try:
            rv = self._driver.execute_async_script(
                """
                const [dbJson, safeMode] = arguments;
                const callback = arguments[arguments.length - 1];
                (async () => {
                  const dir = PathUtils.join(PathUtils.tempDir, "felt-posture-safemode");
                  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
                  await IOUtils.writeUTF8(
                    PathUtils.join(dir, "extensions.json"),
                    dbJson
                  );
                  const { DevicePosture } = ChromeUtils.importESModule(
                    "resource://gre/modules/enterprise/DevicePosture.sys.mjs"
                  );
                  try {
                    return {
                      addons: await DevicePosture.readAddonsForFelt(dir, {
                        safeMode,
                      }),
                    };
                  } finally {
                    await IOUtils.remove(dir, { recursive: true });
                  }
                })().then(callback, err => callback({ _error: String(err) }));
                """,
                [extensions_json, safe_mode],
            )
        finally:
            self._driver.set_context("content")
        assert "_error" not in rv, f"readAddonsForFelt threw: {rv.get('_error')}"
        return rv["addons"]

    def test_posture_without_an_addon_db(self):
        """A profile that has never been launched has no add-on database yet:
        posture reports the list as unknown rather than inventing one on disk."""
        self._manually_closed_child = True
        rv = self._collect_with_addon_db(None)
        assert "_error" not in rv, f"DevicePosture.collect threw: {rv.get('_error')}"
        assert rv["extensions"] is None, (
            f"extensions is unknown without a database, got {rv['extensions']!r}"
        )
        assert rv["hasOs"], "the rest of the posture is still collected"
        assert rv["dbAfter"] is None, "no add-on database is created for the profile"
        self._assert_addon_db_untouched(rv)

    def test_posture_survives_unreadable_addon_db(self):
        """A malformed on-disk add-on database must not break posture collection:
        extensions degrades to null/empty and the rest is still reported."""
        self._manually_closed_child = True
        rv = self._collect_with_addon_db("{ this is not valid json")
        assert "_error" not in rv, (
            f"DevicePosture.collect threw on a malformed add-on DB: {rv.get('_error')}"
        )
        assert rv["extensions"] is None or isinstance(rv["extensions"], list), (
            f"extensions degrades gracefully, got {rv['extensions']!r}"
        )
        assert rv["hasOs"], "the rest of the posture is still collected"
        self._assert_addon_db_untouched(rv)

    def test_felt_parser_agrees_with_the_browsers_addon_manager(self):
        """The parser is checked against a database Firefox wrote rather than a
        fixture: what Felt reports agrees with the browser's own AddonManager.
        This is the drift the parser risks by not going through the add-on code.
        """
        self.get_driver(Environment.FELT).set_prefs(
            {
                "enterprise.felt_tests.should_not_close_window": True,
                "enterprise.felt_tests.is_blocking_shutdown": True,
            },
            default_branch=True,
        )
        super().run_felt_base()
        self.connect_child_browser()

        # Have AddonManager rewrite extensions.json by activating a theme, so the
        # parser faces a database the browser produced. Themes are not a reported
        # type, so this does not change the add-ons Felt reports.
        enabled = self._enable_an_inactive_browser_theme()
        assert "_error" not in enabled, (
            f"could not make the browser rewrite its database: {enabled['_error']}"
        )
        browser_view = self._browser_addon_view()

        # Felt has no window of its own while the browser runs, so quit the
        # browser to get the login window back. Shutdown also flushes the add-on
        # database, leaving the profile as Firefox last wrote it.
        browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._quit_child_browser()
        self.wait_process_exit(browser_pid)
        self.await_felt_auth_window()
        self.force_window()

        app_name = self._driver.session_capabilities.get("browserName")
        # Thunderbird only has "theme", which are not reported
        if app_name != "thunderbird":
            felt_view = self._felt_addon_view()
            assert felt_view, (
                f"Felt reported the browser profile's add-ons, got {felt_view}"
            )
            self._assert_parser_agrees(felt_view, browser_view)

    def _quit_child_browser(self):
        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            "Services.startup.quit(Ci.nsIAppStartup.eForceQuit);"
        )
        try:
            self._child_driver.set_context("content")
        except OSError:
            self._logger.info("Firefox quit before set_context returned")
        self._manually_closed_child = True

    def _assert_parser_agrees(self, felt_view, browser_view):
        # Every add-on of a reported type that AddonManager knows about is
        # reported, so a type the reader cannot actually read out of
        # extensions.json (GMP plugins, ML models) cannot be claimed unnoticed.
        reported_ids = {addon["id"] for addon in felt_view}
        missing = {
            addon_id
            for addon_id, addon in browser_view.items()
            if addon_id not in reported_ids
        }
        assert not missing, (
            f"AddonManager reports {sorted(missing)} as a type device posture "
            "claims to report, but Felt did not report them"
        )

        for addon in felt_view:
            assert addon["id"] in browser_view, (
                f"{addon['id']} is reported but unknown to AddonManager; the "
                "parser's view of extensions.json has drifted"
            )
            expected = browser_view[addon["id"]]
            assert addon["version"] == expected["version"], (
                f"{addon['id']} reported version {addon['version']}, AddonManager "
                f"has {expected['version']}"
            )
            assert addon["enabled"] == expected["isActive"], (
                f"{addon['id']} reported enabled={addon['enabled']}, AddonManager "
                f"has isActive={expected['isActive']}"
            )
            assert addon["name"], f"{addon['id']} was reported without a name"

    def _felt_addon_view(self):
        """The add-ons Felt reports for the running browser's profile."""
        self._driver.set_context("chrome")
        try:
            rv = self._driver.execute_async_script(
                """
                const profileDir = arguments[0];
                const callback = arguments[arguments.length - 1];
                const { DevicePosture } = ChromeUtils.importESModule(
                  "resource://gre/modules/enterprise/DevicePosture.sys.mjs"
                );
                DevicePosture.getExtensions({ profileDir }).then(
                  extensions => callback({ extensions }),
                  err => callback({ _error: String(err) })
                );
                """,
                [self._child_profile_path],
            )
        finally:
            self._driver.set_context("content")
        assert "_error" not in rv, f"getExtensions threw: {rv.get('_error')}"
        return rv["extensions"]

    def _browser_addon_view(self):
        """AddonManager's own view, from inside the browser it belongs to."""
        self._child_driver.set_context("chrome")
        try:
            rv = self._child_driver.execute_async_script(
                """
                const callback = arguments[arguments.length - 1];
                const { AddonManager } = ChromeUtils.importESModule(
                  "resource://gre/modules/AddonManager.sys.mjs"
                );
                // Restricted to the types posture reports, read from the module
                // itself so the comparison covers whatever it claims.
                const { REPORTED_ADDON_TYPES } = ChromeUtils.importESModule(
                  "resource://gre/modules/enterprise/DevicePosture.sys.mjs"
                );
                AddonManager.getAddonsByTypes(REPORTED_ADDON_TYPES).then(
                  addons =>
                    callback(
                      Object.fromEntries(
                        addons.map(addon => [
                          addon.id,
                          { version: addon.version, isActive: addon.isActive },
                        ])
                      )
                    ),
                  err => callback({ _error: String(err) })
                );
                """
            )
        finally:
            self._child_driver.set_context("content")
        assert "_error" not in rv, f"getAddonsByTypes threw: {rv.get('_error')}"
        return rv

    def _enable_an_inactive_browser_theme(self):
        self._child_driver.set_context("chrome")
        try:
            return self._child_driver.execute_async_script(
                """
                const callback = arguments[arguments.length - 1];
                const { AddonManager } = ChromeUtils.importESModule(
                  "resource://gre/modules/AddonManager.sys.mjs"
                );
                (async () => {
                  const themes = await AddonManager.getAddonsByTypes(["theme"]);
                  const target = themes.find(theme => !theme.isActive);
                  if (!target) {
                    return { _error: "no inactive theme to enable" };
                  }
                  await target.enable();
                  return { enabled: target.id };
                })().then(callback, err => callback({ _error: String(err) }));
                """
            )
        finally:
            self._child_driver.set_context("content")

    def _assert_addon_db_untouched(self, rv):
        assert rv["dbAfter"] == rv["dbBefore"], (
            "the launching profile's add-on database is left byte-identical"
        )
        # Reading rewrites no metadata either: size, mtime and permissions are
        # what they were. IOUtils.stat reports no access time, so a read that
        # only bumps atime is still allowed.
        assert rv["statAfter"] == rv["statBefore"], (
            f"the database's metadata is left alone, {rv['statBefore']} became "
            f"{rv['statAfter']}"
        )

    def _collect_with_addon_db(self, extensions_json):
        """Collects posture against a scratch profile directory holding
        extensions_json, or holding no database at all when it is None."""
        self._driver.set_context("chrome")
        try:
            return self._driver.execute_async_script(
                """
                const dbJson = arguments[0];
                const callback = arguments[arguments.length - 1];
                (async () => {
                  const dir = PathUtils.join(PathUtils.tempDir, "felt-posture-addondb");
                  const dbPath = PathUtils.join(dir, "extensions.json");
                  const readOrNull = async path =>
                    (await IOUtils.exists(path)) ? IOUtils.readUTF8(path) : null;
                  const statOrNull = async path => {
                    if (!(await IOUtils.exists(path))) {
                      return null;
                    }
                    const { size, lastModified, permissions } =
                      await IOUtils.stat(path);
                    return { size, lastModified, permissions };
                  };
                  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
                  if (dbJson !== null) {
                    await IOUtils.writeUTF8(dbPath, dbJson);
                  }
                  const { DevicePosture } = ChromeUtils.importESModule(
                    "resource://gre/modules/enterprise/DevicePosture.sys.mjs"
                  );
                  const dbBefore = await readOrNull(dbPath);
                  const statBefore = await statOrNull(dbPath);
                  try {
                    const posture = await DevicePosture.collect({
                      profileDir: dir,
                    });
                    return {
                      extensions: posture.extensions,
                      hasOs: !!(posture.os && posture.os.name),
                      dbBefore,
                      dbAfter: await readOrNull(dbPath),
                      statBefore,
                      statAfter: await statOrNull(dbPath),
                    };
                  } finally {
                    await IOUtils.remove(dir, { recursive: true });
                  }
                })().then(callback, err => callback({ _error: String(err) }));
                """,
                [extensions_json],
            )
        finally:
            self._driver.set_context("content")

    def _collect_with_edr_spy(self, edr_pref_value):
        if edr_pref_value is None:
            set_pref_js = (
                "Services.prefs.clearUserPref('enterprise.posture.edr_agents');"
            )
        else:
            set_pref_js = (
                "Services.prefs.setStringPref('enterprise.posture.edr_agents', "
                f"{json.dumps(edr_pref_value)});"
            )
        self._child_driver.set_context("chrome")
        try:
            return self._child_driver.execute_async_script(
                set_pref_js
                + """
                const callback = arguments[arguments.length - 1];
                const edrMod = ChromeUtils.importESModule(
                  "resource://gre/modules/enterprise/EdrDetection.sys.mjs"
                );
                const { DevicePosture } = ChromeUtils.importESModule(
                  "resource://gre/modules/enterprise/DevicePosture.sys.mjs"
                );
                const original = edrMod.EdrDetection.getPresentEdrs;
                let called = false;
                edrMod.EdrDetection.getPresentEdrs = ids => {
                  called = true;
                  return original(ids);
                };
                DevicePosture.collect()
                  .then(posture => {
                    edrMod.EdrDetection.getPresentEdrs = original;
                    callback({ called, presentEdrs: posture.presentEdrs });
                  })
                  .catch(err => {
                    edrMod.EdrDetection.getPresentEdrs = original;
                    callback({ _error: String(err) });
                  });
                """
            )
        finally:
            self._child_driver.set_context("content")
