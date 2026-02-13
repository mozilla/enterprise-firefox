# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import tempfile

import mozfile
from marionette_harness import MarionetteTestCase


class BackupLegacyToSelectableTest(MarionetteTestCase):
    """
    Tests that a backup created from a legacy profile (without selectable
    profiles enabled) can be successfully recovered in an environment where
    selectable profiles ARE enabled.

    This verifies that stale selectable profile prefs in the backup are
    overwritten with correct values during recovery.
    """

    def setUp(self):
        MarionetteTestCase.setUp(self)
        self._sandbox = "BackupTestSandbox"

        # Backup-related prefs only. Profile-related prefs are set via
        # set_prefs() to avoid leaking through Marionette's prefs mechanism.
        self.marionette.enforce_gecko_prefs({
            "browser.backup.enabled": True,
            "browser.backup.log": True,
            "browser.backup.archive.enabled": True,
            "browser.backup.restore.enabled": True,
            "browser.backup.archive.overridePlatformCheck": True,
            "browser.backup.restore.overridePlatformCheck": True,
            "browser.sessionstore.resume_from_crash": True,
        })
        self.marionette.set_context("chrome")

        # Track resources for cleanup
        self._intermediate_profile_name = None
        self._archive_path = None
        self._recovery_path = None
        self._new_profile_path = None
        self._new_profile_id = None

    def tearDown(self):
        # Clean up any registered profiles from profiles.ini
        if self._intermediate_profile_name:
            try:
                self.marionette.execute_script(
                    """
                    let [profileName] = arguments;
                    let profileSvc = Cc["@mozilla.org/toolkit/profile-service;1"]
                        .getService(Ci.nsIToolkitProfileService);
                    try {
                        let profile = profileSvc.getProfileByName(profileName);
                        if (profile) {
                            profile.remove(false);
                            profileSvc.flush();
                        }
                    } catch (e) {}
                    """,
                    script_args=[self._intermediate_profile_name],
                )
            except Exception:
                pass

        # Clean up files
        for path in [self._archive_path, self._recovery_path, self._new_profile_path]:
            if path:
                mozfile.remove(path)

        self.marionette.quit()
        self.marionette.instance.switch_profile()
        self.marionette.start_session()
        MarionetteTestCase.tearDown(self)

    def run_async(self, script, script_args=None):
        """Run async JS code with error handling. Returns the script's return value."""
        wrapped = f"""
            let args = Array.from(arguments);
            let resolve = args.pop();
            (async () => {{
                try {{
                    return ["OK", await (async () => {{ {script} }})()];
                }} catch (e) {{
                    return ["ERROR", e.name, e.message, e.stack];
                }}
            }})().then(resolve);
        """
        result = self.marionette.execute_async_script(
            wrapped,
            script_args=script_args or [],
            new_sandbox=False,
            sandbox=self._sandbox,
        )
        self.assertEqual("OK", result[0], f"Script error: {result}")
        return result[1]

    def set_prefs(self, prefs):
        """Set prefs via Services.prefs (writes to profile's prefs.js only)."""
        self.marionette.execute_script(
            """
            for (let [name, value] of Object.entries(arguments[0])) {
                if (typeof value === "boolean")
                    Services.prefs.setBoolPref(name, value);
                else if (typeof value === "number")
                    Services.prefs.setIntPref(name, value);
                else if (typeof value === "string")
                    Services.prefs.setStringPref(name, value);
            }
            """,
            script_args=[prefs],
        )

    def test_backup_legacy_to_selectable(self):
        # Part 1: Create backup from legacy profile with stale prefs
        self.set_prefs({
            "browser.profiles.enabled": False,
            "browser.profiles.created": False,
            "toolkit.profiles.storeID": "stale-legacy-store-id",
        })
        self._add_test_data()
        self.marionette.restart()

        self._archive_path = self._create_backup()
        self.assertTrue(
            os.path.exists(self._archive_path), "Backup archive should exist"
        )

        # Part 2: Switch to new profile and enable selectable profiles
        self.marionette.quit()
        self.marionette.instance.switch_profile()
        self.marionette.start_session()
        self.marionette.set_context("chrome")

        self._intermediate_profile_name = self._register_profile_with_toolkit()
        self.marionette.restart(clean=False, in_app=True)
        self.marionette.set_context("chrome")

        self._setup_selectable_profiles()
        original_store_id = self._get_store_id()
        self.assertIsNotNone(original_store_id, "storeID should be set")

        # Part 3: Recover the legacy backup
        self._recovery_path = os.path.join(tempfile.gettempdir(), "legacy-recovery")
        mozfile.remove(self._recovery_path)

        recovery_result = self._recover_backup(self._archive_path, self._recovery_path)
        self._new_profile_path = recovery_result["path"]
        self._new_profile_id = recovery_result["id"]

        # Part 4: Verify recovered profile has correct prefs
        self.marionette.quit()
        intermediate_profile = self.marionette.instance.profile
        self.marionette.instance.profile = self._new_profile_path
        self.marionette.start_session()
        self.marionette.set_context("chrome")

        self._wait_for_post_recovery()
        self._verify_selectable_profile_prefs(original_store_id)

        # Part 5: Cleanup
        self.marionette.quit()
        self.marionette.instance.profile = intermediate_profile
        self.marionette.start_session()
        self.marionette.set_context("chrome")
        self._cleanup_selectable_profiles()

    def _add_test_data(self):
        """Add test data to the legacy profile."""
        self.set_prefs({"test.legacy.backup.pref": "test-value"})

    def _create_backup(self):
        """Create a backup and return the archive path."""
        dest = os.path.join(tempfile.gettempdir(), "legacy-backup-dest")
        return self.run_async(
            """
            const { BackupService } = ChromeUtils.importESModule(
                "resource:///modules/backup/BackupService.sys.mjs"
            );
            let bs = BackupService.init();
            bs.setParentDirPath(arguments[0]);
            let { archivePath } = await bs.createBackup();
            return archivePath;
            """,
            script_args=[dest],
        )

    def _register_profile_with_toolkit(self):
        """Register current profile with toolkit profile service. Returns profile name."""
        return self.run_async(
            """
            let profileSvc = Cc["@mozilla.org/toolkit/profile-service;1"]
                .getService(Ci.nsIToolkitProfileService);
            let profilePath = await IOUtils.getFile(arguments[0]);
            let name = "marionette-selectable-" + Date.now();
            profileSvc.createProfile(profilePath, name);
            profileSvc.flush();
            return name;
            """,
            script_args=[self.marionette.instance.profile.profile],
        )

    def _setup_selectable_profiles(self):
        """Enable and initialize selectable profiles."""
        self.set_prefs({
            "browser.profiles.enabled": True,
            "browser.backup.profiles.force-enable": True,
        })
        self.run_async(
            """
            const { SelectableProfileService } = ChromeUtils.importESModule(
                "resource:///modules/profiles/SelectableProfileService.sys.mjs"
            );
            await SelectableProfileService.init();
            await SelectableProfileService.maybeSetupDataStore();
            """
        )

    def _get_store_id(self):
        """Get the current storeID from SelectableProfileService."""
        return self.marionette.execute_script(
            """
            const { SelectableProfileService } = ChromeUtils.importESModule(
                "resource:///modules/profiles/SelectableProfileService.sys.mjs"
            );
            return SelectableProfileService.storeID;
            """
        )

    def _recover_backup(self, archive_path, recovery_path):
        """Recover backup and return profile info."""
        return self.run_async(
            """
            const { BackupService } = ChromeUtils.importESModule(
                "resource:///modules/backup/BackupService.sys.mjs"
            );
            let [archivePath, recoveryPath] = arguments;
            let bs = BackupService.get();
            let newProfileRoot = await IOUtils.createUniqueDirectory(
                PathUtils.tempDir, "legacyToSelectableTest"
            );
            let profile = await bs.recoverFromBackupArchive(
                archivePath, null, false, recoveryPath, newProfileRoot
            );
            let rootDir = await profile.rootDir;
            return { name: profile.name, path: rootDir.path, id: profile.id };
            """,
            script_args=[archive_path, recovery_path],
        )

    def _wait_for_post_recovery(self):
        """Wait for post-recovery actions to complete."""
        self.run_async(
            """
            const { BackupService } = ChromeUtils.importESModule(
                "resource:///modules/backup/BackupService.sys.mjs"
            );
            await BackupService.get().postRecoveryComplete;
            """
        )

    def _verify_selectable_profile_prefs(self, expected_store_id):
        """Verify the recovered profile has correct selectable profile prefs."""
        self.run_async(
            """
            const { SelectableProfileService } = ChromeUtils.importESModule(
                "resource:///modules/profiles/SelectableProfileService.sys.mjs"
            );
            await SelectableProfileService.init();
            """
        )

        # Verify storeID matches
        store_id = self._get_store_id()
        self.assertEqual(
            store_id,
            expected_store_id,
            "Recovered profile should have the same storeID as profile group",
        )

        # Verify prefs are correct (not stale values from backup)
        prefs = self.marionette.execute_script(
            """
            return {
                enabled: Services.prefs.getBoolPref("browser.profiles.enabled", false),
                created: Services.prefs.getBoolPref("browser.profiles.created", false),
            };
            """
        )
        self.assertTrue(
            prefs["enabled"],
            "browser.profiles.enabled should be true (not stale false from backup)",
        )
        self.assertTrue(
            prefs["created"],
            "browser.profiles.created should be true (not stale false from backup)",
        )

    def _cleanup_selectable_profiles(self):
        """Clean up selectable profiles database and registered profiles."""
        self.run_async(
            """
            let [profileId, profileName] = arguments;
            const { SelectableProfileService } = ChromeUtils.importESModule(
                "resource:///modules/profiles/SelectableProfileService.sys.mjs"
            );
            const { ProfilesDatastoreService } = ChromeUtils.importESModule(
                "moz-src:///toolkit/profile/ProfilesDatastoreService.sys.mjs"
            );

            // Delete the recovered profile from the database
            if (profileId) {
                try {
                    let profile = await SelectableProfileService.getProfile(profileId);
                    if (profile) await SelectableProfileService.deleteProfile(profile);
                } catch (e) {}
            }

            // Delete the profile group database
            let dbPath = await ProfilesDatastoreService.getProfilesStorePath();
            await SelectableProfileService.uninit();
            await ProfilesDatastoreService.uninit();
            for (let suffix of ["", "-shm", "-wal"]) {
                try { await IOUtils.remove(dbPath + suffix); } catch (e) {}
            }

            // Remove intermediate profile from profiles.ini
            if (profileName) {
                let profileSvc = Cc["@mozilla.org/toolkit/profile-service;1"]
                    .getService(Ci.nsIToolkitProfileService);
                try {
                    let profile = profileSvc.getProfileByName(profileName);
                    if (profile) {
                        profile.remove(false);
                        profileSvc.flush();
                    }
                } catch (e) {}
            }
            """,
            script_args=[self._new_profile_id, self._intermediate_profile_name],
        )
