/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/*
 * Unit test for nsIToolkitProfileService.applyEncryptionMismatchRecovery,
 * the public XPCOM method that nsAppRunner's
 * HandleBrowsingChildEncryptionMismatch delegates to when recovering from
 * an encryption-policy mismatch. Exercises both the "delete old files" and
 * "keep old registration" branches.
 */

const ORIGINAL_NAME_DELETE = "enterprise-profile-default-DELETE";
const ORIGINAL_NAME_KEEP = "enterprise-profile-default-KEEP";

function findProfile(profileData, name) {
  return profileData.profiles.find(p => p.name == name);
}

function findRenamedProfile(profileData, originalName) {
  return profileData.profiles.find(p =>
    p.name.startsWith(`${originalName}-plaintext-`)
  );
}

add_task(async function delete_branch() {
  let service = getProfileService();

  let originalRootDir = makeRandomProfileDir(ORIGINAL_NAME_DELETE);
  let originalProfile = service.createProfile(
    originalRootDir,
    ORIGINAL_NAME_DELETE,
    "tests"
  );
  service.defaultProfile = originalProfile;

  let newProfile = service.applyEncryptionMismatchRecovery(
    originalProfile,
    /* aDeleteOldFiles */ true
  );
  Assert.ok(newProfile, "Method should return a new profile.");
  Assert.equal(
    newProfile.name,
    ORIGINAL_NAME_DELETE,
    "New profile should reuse the original name."
  );
  Assert.ok(
    !newProfile.rootDir.equals(originalRootDir),
    "New profile should live in a different (salted) directory."
  );
  Assert.strictEqual(
    service.defaultProfile,
    newProfile,
    "Default should have migrated to the new profile."
  );

  let newProfileLeaf = newProfile.rootDir.leafName;

  service.flush();

  let profileData = readProfilesIni();
  Assert.ok(
    !findRenamedProfile(profileData, ORIGINAL_NAME_DELETE),
    "Old plaintext registration should have been removed."
  );
  let newEntry = findProfile(profileData, ORIGINAL_NAME_DELETE);
  Assert.ok(newEntry, "New profile entry should be present.");
  Assert.ok(
    newEntry.path.endsWith(newProfileLeaf),
    `New profile path (${newEntry.path}) should end with the salted leaf.`
  );

  let hash = xreDirProvider.getInstallHash();
  Assert.ok(
    profileData.installs[hash].default.endsWith(newProfileLeaf),
    "Install default should point at the new profile."
  );

  checkProfileService(profileData);

  newProfile.remove(false);
  service.flush();
});

add_task(async function keep_branch() {
  let service = getProfileService();

  let originalRootDir = makeRandomProfileDir(ORIGINAL_NAME_KEEP);
  let originalProfile = service.createProfile(
    originalRootDir,
    ORIGINAL_NAME_KEEP,
    "tests"
  );
  let capturedOriginalLeaf = originalProfile.rootDir.leafName;
  // Don't make this profile default: verify the method does NOT silently
  // steal default-ness when the recovered profile wasn't the default.
  let preservedDefault = service.defaultProfile;

  let newProfile = service.applyEncryptionMismatchRecovery(
    originalProfile,
    /* aDeleteOldFiles */ false
  );
  Assert.ok(newProfile, "Method should return a new profile.");
  Assert.equal(
    newProfile.name,
    ORIGINAL_NAME_KEEP,
    "New profile should reuse the original name."
  );
  Assert.equal(
    service.defaultProfile,
    preservedDefault,
    "Default should not change when the recovered profile wasn't default."
  );

  let newProfileLeaf = newProfile.rootDir.leafName;

  service.flush();

  let profileData = readProfilesIni();
  let renamedEntry = findRenamedProfile(profileData, ORIGINAL_NAME_KEEP);
  Assert.ok(renamedEntry, "Renamed plaintext registration should be present.");
  Assert.equal(
    renamedEntry.path,
    capturedOriginalLeaf,
    "Renamed profile should still point at the original root dir."
  );
  let newEntry = findProfile(profileData, ORIGINAL_NAME_KEEP);
  Assert.ok(newEntry, "New profile entry should be present.");
  Assert.ok(
    newEntry.path.endsWith(newProfileLeaf),
    `New profile path (${newEntry.path}) should end with the salted leaf.`
  );

  checkProfileService(profileData);

  // Cleanup: remove both registrations.
  let renamed = service.getProfileByName(renamedEntry.name);
  renamed.remove(false);
  newProfile.remove(false);
  service.flush();
});
