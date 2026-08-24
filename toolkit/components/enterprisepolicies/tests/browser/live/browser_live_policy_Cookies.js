/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const ALLOW = Ci.nsIPermissionManager.ALLOW_ACTION;
const DENY = Ci.nsIPermissionManager.DENY_ACTION;
const UNKNOWN = Ci.nsIPermissionManager.UNKNOWN_ACTION;

const BEHAVIOR_PREF = "network.cookie.cookieBehavior";
const BEHAVIOR_PB_PREF = "network.cookie.cookieBehavior.pbmode";

function principalFor(origin) {
  return Services.scriptSecurityManager.createContentPrincipalFromOrigin(
    origin
  );
}

function getCurrentCookiePermission(origin) {
  return Services.perms.testPermissionFromPrincipal(
    principalFor(origin),
    "cookie"
  );
}

function getPersistDataPermission(origin) {
  return Services.perms.testPermissionFromPrincipal(
    principalFor(origin),
    "persist-data-on-shutdown"
  );
}

function checkBehaviorPref(prefName, expectedValue, expectedLocked) {
  Assert.strictEqual(
    Services.prefs.getIntPref(prefName),
    expectedValue,
    `${prefName} has the expected value`
  );
  Assert.equal(
    Services.prefs.prefIsLocked(prefName),
    expectedLocked,
    `${prefName} lock status is as expected`
  );
}

// Applying a Cookies policy, updating it live and removing it live should be
// reflected in the cookieBehavior prefs' values and lock status
add_task(async function test_cookie_behavior_apply_update_remove() {
  const initialBehavior = Services.prefs.getIntPref(BEHAVIOR_PREF);
  const initialBehaviorPB = Services.prefs.getIntPref(BEHAVIOR_PB_PREF);

  info("Applying Cookies policy config with locked reject behavior.");
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        Cookies: {
          Behavior: "reject",
          BehaviorPrivateBrowsing: "reject",
          Locked: true,
        },
      },
    },
    null
  );

  checkBehaviorPref(BEHAVIOR_PREF, Ci.nsICookieService.BEHAVIOR_REJECT, true);
  checkBehaviorPref(
    BEHAVIOR_PB_PREF,
    Ci.nsICookieService.BEHAVIOR_REJECT,
    true
  );

  info("Updating Cookies policy to unlocked accept behavior.");
  await waitForLivePolicyUpdate({
    Cookies: {
      Behavior: "accept",
      BehaviorPrivateBrowsing: "accept",
    },
  });

  checkBehaviorPref(BEHAVIOR_PREF, Ci.nsICookieService.BEHAVIOR_ACCEPT, false);
  checkBehaviorPref(
    BEHAVIOR_PB_PREF,
    Ci.nsICookieService.BEHAVIOR_ACCEPT,
    false
  );

  info("Removing the Cookies policy.");
  await waitForLivePolicyUpdate({});

  checkBehaviorPref(BEHAVIOR_PREF, initialBehavior, false);
  checkBehaviorPref(BEHAVIOR_PB_PREF, initialBehaviorPB, false);
});

// Allow/Block permission entries added by the Cookies policy must be cleared on policy removal
add_task(async function test_cookie_permissions_removed_on_remove() {
  const allowOrigin = "https://allow.example.com";
  const blockOrigin = "https://block.example.com";
  const sessionOrigin = "https://session.example.com";

  registerCleanupFunction(() => {
    Services.perms.removeByType("cookie");
    Services.perms.removeByType("persist-data-on-shutdown");
  });

  info("Applying a Cookies policy config with Allow/Block/AllowSession lists.");
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        Cookies: {
          Allow: [allowOrigin],
          Block: [blockOrigin],
          AllowSession: [sessionOrigin],
        },
      },
    },
    null
  );

  Assert.equal(
    getCurrentCookiePermission(allowOrigin),
    ALLOW,
    "Allow entry was added"
  );
  Assert.equal(
    getCurrentCookiePermission(blockOrigin),
    DENY,
    "Block entry was added"
  );
  Assert.equal(
    getCurrentCookiePermission(sessionOrigin),
    Ci.nsICookiePermission.ACCESS_SESSION,
    "AllowSession entry was added"
  );

  info("Removing the Cookies policy.");
  await waitForLivePolicyUpdate({});

  Assert.equal(
    getCurrentCookiePermission(allowOrigin),
    UNKNOWN,
    "Allow entry was removed on live removal"
  );
  Assert.equal(
    getCurrentCookiePermission(blockOrigin),
    UNKNOWN,
    "Block entry was removed on live removal"
  );
  Assert.equal(
    getCurrentCookiePermission(sessionOrigin),
    UNKNOWN,
    "AllowSession entry was removed on live removal"
  );
});

// An update to the Cookies policy that shrinks the Allow list must drop the entry that is no
// longer present
add_task(async function test_cookie_permissions_reconciled_on_update() {
  const keptOrigin = "https://kept.example.com";
  const droppedOrigin = "https://dropped.example.com";

  registerCleanupFunction(() => {
    Services.perms.removeByType("cookie");
    Services.perms.removeByType("persist-data-on-shutdown");
  });

  info("Applying a Cookies policy config allowing two origins.");
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        Cookies: {
          Allow: [keptOrigin, droppedOrigin],
        },
      },
    },
    null
  );

  Assert.equal(
    getCurrentCookiePermission(keptOrigin),
    ALLOW,
    "kept origin allowed"
  );
  Assert.equal(
    getCurrentCookiePermission(droppedOrigin),
    ALLOW,
    "dropped origin allowed"
  );

  info("Updating Cookies policy config to allow only the first origin.");
  await waitForLivePolicyUpdate({
    Cookies: {
      Allow: [keptOrigin],
    },
  });

  Assert.equal(
    getCurrentCookiePermission(keptOrigin),
    ALLOW,
    "kept origin is still allowed after update"
  );
  Assert.equal(
    getCurrentCookiePermission(droppedOrigin),
    UNKNOWN,
    "dropped origin's stale entry was reconciled away on live update"
  );
});

// The deprecated Cookies.Allow shim mirrors Allow origins into
// persist-data-on-shutdown; onRemove intentionally leaves those entries in
// place as the shim is being removed (see Bug 2051574).
add_task(
  async function test_persist_data_on_shutdown_not_cleared_on_policy_removal_compat() {
    const allowOrigin = "https://persist.example.com";

    registerCleanupFunction(() => {
      Services.perms.removeByType("cookie");
      Services.perms.removeByType("persist-data-on-shutdown");
    });

    info(
      "Applying a Cookies policy config with an Allow list; no SanitizeOnShutdown policy is present."
    );
    await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
      {
        policies: {
          Cookies: {
            Allow: [allowOrigin],
          },
        },
      },
      null
    );

    Assert.equal(
      getPersistDataPermission(allowOrigin),
      ALLOW,
      "persist-data-on-shutdown entry was added by the Allow shim"
    );

    info("Removing the Cookies policy.");
    await waitForLivePolicyUpdate({});

    Assert.equal(
      getPersistDataPermission(allowOrigin),
      ALLOW,
      "persist-data-on-shutdown entry from the deprecated shim is left in place on removal"
    );
  }
);
