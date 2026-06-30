/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/*
 * Unit test for the profile-service rename + create + setNormalDefault + flush
 * sequence used by the enterprise encryption-mismatch recovery path. This
 * exercises the profile-service API only; it does not touch nsAppRunner.
 */

const ORIGINAL_NAME = "enterprise-profile-default-TEST";

add_task(async () => {
  let service = getProfileService();

  // 1. Create the original profile with a known root dir.
  let originalRootDir = makeRandomProfileDir(ORIGINAL_NAME);
  let originalProfile = service.createProfile(
    originalRootDir,
    ORIGINAL_NAME,
    "tests"
  );

  // 2. Capture the original name + root path.
  let capturedOriginalName = originalProfile.name;
  let capturedOriginalPath = originalProfile.rootDir.path;
  let capturedOriginalLeaf = originalProfile.rootDir.leafName;
  Assert.equal(
    capturedOriginalName,
    ORIGINAL_NAME,
    "Original profile should have the expected name."
  );
  Assert.equal(
    capturedOriginalPath,
    originalRootDir.path,
    "Original profile should be at the requested root dir."
  );

  // 3. Rename it to add "-plaintext-" + a timestamp suffix.
  let renamedName = `${ORIGINAL_NAME}-plaintext-${Date.now()}`;
  originalProfile.name = renamedName;
  Assert.equal(
    originalProfile.name,
    renamedName,
    "Rename should update the profile's name in-memory."
  );

  // 4. CreateProfile with the ORIGINAL name and nullptr root dir
  // (SaltProfileName will pick a fresh, salted directory).
  let newProfile = service.createProfile(null, ORIGINAL_NAME, "tests");
  Assert.equal(
    newProfile.name,
    ORIGINAL_NAME,
    "New profile should reuse the original name."
  );
  Assert.ok(
    !newProfile.rootDir.equals(originalRootDir),
    "New profile should live in a different directory than the renamed one."
  );
  let newProfileLeaf = newProfile.rootDir.leafName;

  // 5. setNormalDefault on the new profile (JS-visible: defaultProfile=).
  service.defaultProfile = newProfile;
  Assert.strictEqual(
    service.defaultProfile,
    newProfile,
    "Default profile should now be the new profile."
  );

  // 6. Flush.
  service.flush();

  // 7. Read profiles.ini back and assert both entries exist with the expected
  // names + paths, Default points to the new profile's path.
  let profileData = readProfilesIni();

  Assert.equal(
    profileData.profiles.length,
    2,
    "profiles.ini should contain both the renamed and the new profile."
  );

  let renamedEntry = profileData.profiles.find(p => p.name == renamedName);
  Assert.ok(renamedEntry, "Renamed profile entry should be present.");
  Assert.equal(
    renamedEntry.path,
    capturedOriginalLeaf,
    "Renamed profile should still point at the original root dir."
  );

  let newEntry = profileData.profiles.find(p => p.name == ORIGINAL_NAME);
  Assert.ok(newEntry, "Newly created profile entry should be present.");
  // The new profile lives under the install's Profiles/ root (rootDir was
  // null at create time, so the service picked a salted path); profiles.ini
  // stores it relative-to that root with the "Profiles/" prefix.
  Assert.ok(
    newEntry.path.endsWith(newProfileLeaf),
    `New profile entry path (${newEntry.path}) should end with the salted leaf (${newProfileLeaf}).`
  );

  let hash = xreDirProvider.getInstallHash();
  Assert.ok(
    profileData.installs && hash in profileData.installs,
    "An install entry should have been written for this build."
  );
  Assert.ok(
    profileData.installs[hash].default.endsWith(newProfileLeaf),
    `Install default (${profileData.installs[hash].default}) should end with the new profile's salted leaf (${newProfileLeaf}).`
  );

  checkProfileService(profileData);

  // 8. Cleanup: remove both profiles.
  originalProfile.remove(false);
  newProfile.remove(false);
  service.flush();

  let cleaned = readProfilesIni();
  Assert.equal(
    cleaned.profiles.length,
    0,
    "Both profiles should be removed after cleanup."
  );
});
