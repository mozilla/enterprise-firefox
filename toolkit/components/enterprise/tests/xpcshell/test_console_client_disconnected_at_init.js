/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// FeltStorage computes FELT_FILE_PATH from UAppData at import time, so the
// key must point inside the test profile before ConsoleClient is imported.
const gDataHome = do_get_profile().clone();
gDataHome.append("appdata");
gDataHome.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
Services.dirsvc.set("UAppData", gDataHome);

const { ForcedQuitHandler } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/ForcedQuitHandler.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const gQuitCalls = [];
let gDisconnected = false;
let ConsoleClient;

// ConsoleClient.init() runs at import, so the fakes must be in place first.
add_setup(function () {
  const hadFelt = Object.prototype.hasOwnProperty.call(Services, "felt");
  const originalFelt = hadFelt ? Services.felt : undefined;
  const originalStartup = Services.startup;
  const originalHook = ForcedQuitHandler._appForcedQuitHook;

  /* eslint-disable mozilla/valid-services */
  Object.defineProperty(Services, "felt", {
    value: {
      isFeltBrowser: () => true,
      isFeltUI: () => false,
      isDisconnected: () => gDisconnected,
      getAccessTokenIfValid: () => "",
    },
    configurable: true,
    writable: true,
  });
  /* eslint-enable mozilla/valid-services */
  Services.startup = {
    quit: flags => gQuitCalls.push(flags),
    shuttingDown: true,
  };
  ForcedQuitHandler._appForcedQuitHook = () => null;

  ({ ConsoleClient } = ChromeUtils.importESModule(
    "resource://gre/modules/enterprise/ConsoleClient.sys.mjs"
  ));

  registerCleanupFunction(() => {
    ConsoleClient.observe(null, "xpcom-shutdown");
    ForcedQuitHandler._appForcedQuitHook = originalHook;
    ForcedQuitHandler._quitPromise = null;
    ForcedQuitHandler._pendingQuitFlags = 0;
    Services.startup = originalStartup;
    if (hadFelt) {
      Services.felt = originalFelt;
    } else {
      delete Services.felt;
    }
  });
});

add_task(async function test_connected_at_init_does_not_quit() {
  await TestUtils.waitForTick();
  Assert.equal(
    gQuitCalls.length,
    0,
    "A live connection at init requests no quit"
  );
});

add_task(async function test_disconnected_before_init_quits() {
  gDisconnected = true;
  // Release the import-time registration the way xpcom-shutdown does, then
  // initialize again as a browser whose connection died during startup would.
  ConsoleClient.observe(null, "xpcom-shutdown");
  ConsoleClient.init();

  await TestUtils.waitForCondition(
    () => gQuitCalls.length,
    "ConsoleClient requests a quit for the recorded disconnect"
  );
  Assert.deepEqual(
    gQuitCalls,
    [Ci.nsIAppStartup.eForceQuit],
    "A disconnect recorded before init forces a quit"
  );
});
