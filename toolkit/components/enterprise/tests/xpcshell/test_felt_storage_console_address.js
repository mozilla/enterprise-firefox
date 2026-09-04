/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// FeltStorage computes FELT_FILE_PATH from UAppData at import time, so the
// key must point inside the test profile before the module is imported.
const gDataHome = do_get_profile().clone();
gDataHome.append("appdata");
gDataHome.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
Services.dirsvc.set("UAppData", gDataHome);

const { FeltStorage } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/FeltStorage.sys.mjs"
);

const ADDRESS = "https://console.example.com/";

async function resetStorage() {
  if (FeltStorage._initialized) {
    await FeltStorage._feltStorage.finalize();
  }
  await FeltStorage.uninit();
  await IOUtils.remove(FeltStorage.FELT_FILE_PATH, { ignoreAbsent: true });
}

registerCleanupFunction(resetStorage);

add_task(async function test_no_address_by_default() {
  await resetStorage();
  await FeltStorage.init();

  Assert.strictEqual(
    FeltStorage.getConsoleAddress(),
    undefined,
    "No console address is stored initially"
  );
});

add_task(async function test_persist_writes_immediately() {
  await resetStorage();
  await FeltStorage.init();
  await FeltStorage.persistConsoleAddress(ADDRESS);

  // The console setup dialog relaunches right after persisting, so the
  // address must already be on disk, without waiting for a deferred save.
  const onDisk = await IOUtils.readJSON(FeltStorage.FELT_FILE_PATH);
  Assert.equal(
    onDisk.consoleAddress,
    ADDRESS,
    "The address is flushed to felt.json as soon as persist resolves"
  );
  Assert.equal(
    FeltStorage.getConsoleAddress(),
    ADDRESS,
    "getConsoleAddress returns the persisted address"
  );
});

add_task(async function test_persist_keeps_other_keys() {
  await resetStorage();
  await FeltStorage.init();

  const deviceId = FeltStorage.getDeviceId();
  FeltStorage.updateLastSignedInUserEmail("user@example.com");
  await FeltStorage.persistConsoleAddress(ADDRESS);

  const onDisk = await IOUtils.readJSON(FeltStorage.FELT_FILE_PATH);
  Assert.equal(onDisk.consoleAddress, ADDRESS, "The address was written");
  Assert.equal(onDisk.deviceId, deviceId, "The device id is preserved");
  Assert.equal(
    onDisk.lastSignedInUserEmail,
    "user@example.com",
    "The last signed in email is preserved"
  );
});

add_task(async function test_address_survives_reload() {
  await resetStorage();
  await FeltStorage.init();
  await FeltStorage.persistConsoleAddress(ADDRESS);

  // A fresh init after the post-dialog relaunch must read the address back
  // from disk.
  await FeltStorage.uninit();
  await FeltStorage.init();
  Assert.equal(
    FeltStorage.getConsoleAddress(),
    ADDRESS,
    "The persisted address is read back after a reload"
  );
});
