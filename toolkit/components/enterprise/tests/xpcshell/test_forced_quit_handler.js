/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { ForcedQuitHandler } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/enterprise/modules/ForcedQuitHandler.sys.mjs"
);

add_task(async function test_concurrent_quit_requests_preserve_restart() {
  const { promise: hookPromise, resolve: finishHook } = Promise.withResolvers();
  const originalHook = ForcedQuitHandler._appForcedQuitHook;
  const originalStartup = Services.startup;
  const quitCalls = [];
  let hookCalls = 0;
  let firstQuit;
  let secondQuit;

  ForcedQuitHandler._appForcedQuitHook = () => () => {
    hookCalls++;
    return hookPromise;
  };
  Services.startup = {
    quit: flags => quitCalls.push(flags),
    shuttingDown: true,
  };

  try {
    firstQuit = ForcedQuitHandler.quitIgnoringCanClose();
    secondQuit = ForcedQuitHandler.quitIgnoringCanClose(
      Ci.nsIAppStartup.eForceQuit | Ci.nsIAppStartup.eRestart
    );

    Assert.equal(firstQuit, secondQuit, "Concurrent callers share the promise");
    await Promise.resolve();
    Assert.equal(hookCalls, 1, "The hook runs once");
    Assert.equal(quitCalls.length, 0, "Quit waits for the hook");

    finishHook();
    await Promise.all([firstQuit, secondQuit]);

    Assert.deepEqual(
      quitCalls,
      [Ci.nsIAppStartup.eForceQuit | Ci.nsIAppStartup.eRestart],
      "The single quit includes the later restart flag"
    );
    Assert.equal(
      ForcedQuitHandler.quitIgnoringCanClose(),
      firstQuit,
      "A later request does not start another quit"
    );
  } finally {
    finishHook();
    await Promise.allSettled([firstQuit, secondQuit].filter(Boolean));
    ForcedQuitHandler._appForcedQuitHook = originalHook;
    ForcedQuitHandler._quitPromise = null;
    ForcedQuitHandler._pendingQuitFlags = 0;
    Services.startup = originalStartup;
  }
});

add_task(async function test_vetoed_quit_can_retry() {
  const originalHook = ForcedQuitHandler._appForcedQuitHook;
  const originalStartup = Services.startup;
  const quitCalls = [];

  ForcedQuitHandler._appForcedQuitHook = () => () => {};
  Services.startup = {
    quit: flags => quitCalls.push(flags),
    shuttingDown: false,
  };

  try {
    const firstQuit = ForcedQuitHandler.quitIgnoringCanClose(
      Ci.nsIAppStartup.eForceQuit | Ci.nsIAppStartup.eRestart
    );
    await firstQuit;

    const secondQuit = ForcedQuitHandler.quitIgnoringCanClose();
    Assert.notEqual(secondQuit, firstQuit, "A vetoed quit can be retried");
    await secondQuit;

    Assert.deepEqual(
      quitCalls,
      [
        Ci.nsIAppStartup.eForceQuit | Ci.nsIAppStartup.eRestart,
        Ci.nsIAppStartup.eForceQuit,
      ],
      "A retry starts a fresh quit request"
    );
  } finally {
    ForcedQuitHandler._appForcedQuitHook = originalHook;
    ForcedQuitHandler._quitPromise = null;
    ForcedQuitHandler._pendingQuitFlags = 0;
    Services.startup = originalStartup;
  }
});
