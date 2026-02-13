# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""
Tests that backups created with older manifest versions can still be
recovered by the current version of Firefox.

This ensures backward compatibility as the backup schema evolves.

To add a new version:
1. Before bumping SCHEMA_VERSION, run test_generate_backup_fixture.py to create the fixture
2. Add entry to VERSION_CONFIG with backup_file, extra_checks list
3. Implement any new _verify_* methods for extra_checks
4. Add test method: test_recover_vN_backup calling _test_recover_backup(N)
"""

import os
import tempfile

import mozfile
from marionette_harness import MarionetteTestCase

VERSION_CONFIG = {
    1: {
        "backup_file": "v1_backup.html",
        "recovery_password": "v1-test-recovery-password",
        "extra_checks": [],
    },
}


class BackupCompatibilityTest(MarionetteTestCase):
    """Test backward compatibility of backup recovery across schema versions."""

    def setUp(self):
        MarionetteTestCase.setUp(self)

        self.marionette.enforce_gecko_prefs({
            "browser.backup.enabled": True,
            "browser.backup.log": True,
            "browser.backup.archive.enabled": True,
            "browser.backup.restore.enabled": True,
            "browser.backup.archive.overridePlatformCheck": True,
            "browser.backup.restore.overridePlatformCheck": True,
        })

        self.marionette.set_context("chrome")
        self._recovery_path = None
        self._new_profile_path = None
        self._intermediate_profile = None

    def tearDown(self):
        if self._intermediate_profile:
            self.marionette.quit()
            self.marionette.instance.profile = self._intermediate_profile
            self.marionette.start_session()

        if self._recovery_path:
            mozfile.remove(self._recovery_path)
        if self._new_profile_path:
            mozfile.remove(self._new_profile_path)

        self.marionette.quit()
        self.marionette.instance.switch_profile()
        self.marionette.start_session()
        MarionetteTestCase.tearDown(self)

    def test_recover_v1_backup(self):
        """Test that a v1 backup can be recovered and data is intact."""
        self._test_recover_backup(1)

    def _test_recover_backup(self, version):
        """Generic test for recovering a backup of a specific version."""
        config = VERSION_CONFIG[version]
        backup_path = self._get_backup_path(config["backup_file"])
        self.assertTrue(
            os.path.exists(backup_path),
            f"V{version} backup fixture must exist at {backup_path}",
        )

        self._recovery_path = os.path.join(
            tempfile.gettempdir(), f"v{version}-compat-recovery"
        )
        mozfile.remove(self._recovery_path)

        result = self._recover_backup(
            backup_path, self._recovery_path, config["recovery_password"]
        )
        self._new_profile_path = result["path"]

        self.marionette.quit()
        self._intermediate_profile = self.marionette.instance.profile
        self.marionette.instance.profile = self._new_profile_path
        self.marionette.start_session()
        self.marionette.set_context("chrome")

        self._wait_for_post_recovery()

        self._verify_common_data(version)

        for check in config["extra_checks"]:
            verify_method = getattr(self, f"_verify_{check}")
            verify_method(version)

    def _verify_common_data(self, version):
        """Verify data that should exist in all backup versions."""
        prefix = f"v{version}-test"
        self._verify_login(f"https://{prefix}.example.com")
        self._verify_bookmark(f"https://{prefix}.example.com/bookmark")
        self._verify_history(f"https://{prefix}.example.com/history")
        self._verify_preference(f"test.v{version}.compatibility.pref")

    def _get_backup_path(self, filename):
        """Get path to a backup fixture."""
        test_dir = os.path.dirname(__file__)
        return os.path.join(test_dir, "backups", filename)

    def _recover_backup(self, archive_path, recovery_path, recovery_password):
        """Recover from an encrypted backup archive."""
        return self.marionette.execute_async_script(
            """
            const { OSKeyStore } = ChromeUtils.importESModule(
                "resource://gre/modules/OSKeyStore.sys.mjs"
            );
            const { BackupService } = ChromeUtils.importESModule(
                "resource:///modules/backup/BackupService.sys.mjs"
            );
            let [archivePath, recoveryCode, recoveryPath, outerResolve] = arguments;
            (async () => {
                // Use a fake OSKeyStore label to avoid keychain auth prompts
                OSKeyStore.STORE_LABEL = "test-" + Math.random().toString(36).substr(2);

                let bs = BackupService.init();
                let newProfileRoot = await IOUtils.createUniqueDirectory(
                    PathUtils.tempDir, "backupCompatTest"
                );
                let profile = await bs.recoverFromBackupArchive(
                    archivePath, recoveryCode, false, recoveryPath, newProfileRoot
                );
                let rootDir = await profile.rootDir;
                return { name: profile.name, path: rootDir.path, id: profile.id };
            })().then(outerResolve);
            """,
            script_args=[archive_path, recovery_password, recovery_path],
        )

    def _wait_for_post_recovery(self):
        """Wait for post-recovery actions to complete."""
        self.marionette.execute_async_script(
            """
            const { BackupService } = ChromeUtils.importESModule(
                "resource:///modules/backup/BackupService.sys.mjs"
            );
            let [outerResolve] = arguments;
            (async () => {
                await BackupService.get().postRecoveryComplete;
            })().then(outerResolve);
            """
        )

    def _verify_login(self, origin):
        """Verify a login exists for the given origin."""
        count = self.marionette.execute_async_script(
            """
            let [origin, outerResolve] = arguments;
            (async () => {
                let logins = await Services.logins.searchLoginsAsync({
                    origin: origin,
                });
                return logins.length;
            })().then(outerResolve);
            """,
            script_args=[origin],
        )
        self.assertEqual(count, 1, f"Login for {origin} should exist")

    def _verify_bookmark(self, url):
        """Verify a bookmark exists for the given URL."""
        exists = self.marionette.execute_async_script(
            """
            const { PlacesUtils } = ChromeUtils.importESModule(
                "resource://gre/modules/PlacesUtils.sys.mjs"
            );
            let [url, outerResolve] = arguments;
            (async () => {
                let bookmark = await PlacesUtils.bookmarks.fetch({ url });
                return bookmark != null;
            })().then(outerResolve);
            """,
            script_args=[url],
        )
        self.assertTrue(exists, f"Bookmark for {url} should exist")

    def _verify_history(self, url):
        """Verify a history entry exists for the given URL."""
        exists = self.marionette.execute_async_script(
            """
            const { PlacesUtils } = ChromeUtils.importESModule(
                "resource://gre/modules/PlacesUtils.sys.mjs"
            );
            let [url, outerResolve] = arguments;
            (async () => {
                let entry = await PlacesUtils.history.fetch(url);
                return entry != null;
            })().then(outerResolve);
            """,
            script_args=[url],
        )
        self.assertTrue(exists, f"History for {url} should exist")

    def _verify_preference(self, pref_name):
        """Verify a preference exists and is true."""
        value = self.marionette.execute_script(
            """
            let [prefName] = arguments;
            return Services.prefs.getBoolPref(prefName, false);
            """,
            script_args=[pref_name],
        )
        self.assertTrue(value, f"Preference {pref_name} should be true")
