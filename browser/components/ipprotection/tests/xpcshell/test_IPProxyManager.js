/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { IPPEnrollAndEntitleManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/ipprotection/IPPEnrollAndEntitleManager.sys.mjs"
);

add_setup(async function () {
  await putServerInRemoteSettings();
});

/**
 * Tests that starting the service gets a state changed event.
 */
add_task(async function test_IPPProxyManager_start() {
  let sandbox = sinon.createSandbox();
  setupStubs(sandbox);

  let readyEventPromise = waitForEvent(
    IPProtectionService,
    "IPProtectionService:StateChanged",
    () => IPProtectionService.state === IPProtectionStates.READY
  );

  IPProtectionService.init();

  await readyEventPromise;

  Assert.ok(
    !IPPProxyManager.activatedAt,
    "IP Protection service should not be active initially"
  );

  let startedEventPromise = waitForEvent(
    IPPProxyManager,
    "IPPProxyManager:StateChanged",
    () => IPPProxyManager.state === IPPProxyStates.ACTIVE
  );

  IPPProxyManager.start();

  Assert.equal(
    IPPProxyManager.state,
    IPPProxyStates.ACTIVATING,
    "Proxy activation"
  );
  await startedEventPromise;

  Assert.equal(
    IPPProxyManager.state,
    IPPProxyStates.ACTIVE,
    "IP Protection service should be active after starting"
  );
  Assert.ok(
    !!IPPProxyManager.activatedAt,
    "IP Protection service should have an activation timestamp"
  );
  Assert.ok(
    IPPProxyManager.active,
    "IP Protection service should have an active connection"
  );

  Assert.notEqual(
    IPPProxyManager.usageInfo,
    null,
    "IP Protection service should have usage info after starting"
  );
  Assert.ok(
    IPPProxyManager.usageInfo instanceof ProxyUsage,
    "usageInfo should be an instance of ProxyUsage"
  );

  IPProtectionService.uninit();
  sandbox.restore();
});

/**
 * Tests that stopping the service gets stop events.
 */
add_task(async function test_IPPProxyManager_stop() {
  let sandbox = sinon.createSandbox();
  setupStubs(sandbox);

  const waitForReady = waitForEvent(
    IPProtectionService,
    "IPProtectionService:StateChanged",
    () => IPProtectionService.state === IPProtectionStates.READY
  );

  IPProtectionService.init();
  await waitForReady;

  await IPPProxyManager.start();

  let stoppedEventPromise = waitForEvent(
    IPPProxyManager,
    "IPPProxyManager:StateChanged",
    () => IPPProxyManager.state === IPPProxyStates.READY
  );
  await IPPProxyManager.stop();

  await stoppedEventPromise;
  Assert.equal(
    IPPProxyManager.state,
    IPPProxyStates.READY,
    "IP Protection service should not be active after stopping"
  );
  Assert.ok(
    !IPPProxyManager.activatedAt,
    "IP Protection service should not have an activation timestamp after stopping"
  );
  Assert.ok(
    !IPProtectionService.connection,
    "IP Protection service should not have an active connection"
  );
  Assert.notEqual(
    IPPProxyManager.usageInfo,
    null,
    "IP Protection service should still have usage info after stopping"
  );
  Assert.ok(
    IPPProxyManager.usageInfo instanceof ProxyUsage,
    "usageInfo should be an instance of ProxyUsage"
  );

  IPProtectionService.uninit();
  sandbox.restore();
});

/**
 * Tests that the proxy manager gets proxy pass and connection on starting
 * and removes the connection after after stop.
 */
add_task(async function test_IPPProxyManager_start_stop_reset() {
  const sandbox = sinon.createSandbox();
  setupStubs(sandbox);

  let readyEvent = waitForEvent(
    IPProtectionService,
    "IPProtectionService:StateChanged",
    () => IPProtectionService.state === IPProtectionStates.READY
  );

  IPProtectionService.init();
  await readyEvent;

  await IPPProxyManager.start();

  Assert.ok(IPPProxyManager.active, "Should be active after starting");

  Assert.ok(
    IPPProxyManager.isolationKey,
    "Should have an isolationKey after starting"
  );

  Assert.ok(
    IPPProxyManager.hasValidProxyPass,
    "Should have a valid proxy pass after starting"
  );

  await IPPProxyManager.stop();

  Assert.ok(!IPPProxyManager.active, "Should not be active after starting");

  Assert.ok(
    !IPPProxyManager.isolationKey,
    "Should not have an isolationKey after stopping"
  );

  sandbox.restore();
});

/**
 * Tests that the proxy manager gets proxy pass and connection on starting
 * and removes them after stop / reset.
 */
add_task(async function test_IPPProxyManager_reset() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(IPProtectionService.guardian, "fetchProxyPass").returns({
    status: 200,
    error: undefined,
    pass: new ProxyPass(createProxyPassToken()),
    usage: new ProxyUsage(
      "5368709120",
      "4294967296",
      "2026-02-01T00:00:00.000Z"
    ),
  });

  await IPPProxyManager.start();

  Assert.ok(IPPProxyManager.active, "Should be active after starting");

  Assert.ok(
    IPPProxyManager.isolationKey,
    "Should have an isolationKey after starting"
  );

  Assert.ok(
    IPPProxyManager.hasValidProxyPass,
    "Should have a valid proxy pass after starting"
  );

  await IPPProxyManager.reset();

  Assert.ok(!IPPProxyManager.active, "Should not be active after reset");

  Assert.ok(
    !IPPProxyManager.isolationKey,
    "Should not have an isolationKey after reset"
  );

  Assert.equal(
    IPPProxyManager.usageInfo,
    null,
    "Should not have usage info after reset"
  );

  Assert.ok(
    !IPPProxyManager.hasValidProxyPass,
    "Should not have a proxy pass after reset"
  );

  sandbox.restore();
});

/**
 * Tests the error state.
 */
add_task(async function test_IPPProxyStates_error() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(IPPSignInWatcher, "isSignedIn").get(() => true);
  sandbox
    .stub(IPProtectionService.guardian, "isLinkedToGuardian")
    .resolves(true);
  sandbox.stub(IPProtectionService.guardian, "fetchUserInfo").resolves({
    status: 200,
    error: undefined,
    entitlement: createTestEntitlement(),
  });
  sandbox
    .stub(IPPEnrollAndEntitleManager, "maybeEnrollAndEntitle")
    .resolves({ isEnrolledAndEntitled: false });

  await IPProtectionService.init();

  Assert.equal(
    IPProtectionService.state,
    IPProtectionStates.READY,
    "IP Protection service should be ready"
  );

  await IPPProxyManager.start(false);

  Assert.equal(
    IPPProxyManager.state,
    IPPProxyStates.ERROR,
    "IP Protection service should be active"
  );

  IPProtectionService.uninit();
  sandbox.restore();
});

/**
 * Tests that usage data is preserved when quota is exceeded.
 */
add_task(async function test_IPPProxyManager_quota_exceeded() {
  let sandbox = sinon.createSandbox();

  sandbox.stub(IPPSignInWatcher, "isSignedIn").get(() => true);
  sandbox
    .stub(IPProtectionService.guardian, "isLinkedToGuardian")
    .resolves(true);
  sandbox.stub(IPProtectionService.guardian, "fetchUserInfo").resolves({
    status: 200,
    error: undefined,
    entitlement: createTestEntitlement(),
  });
  await putServerInRemoteSettings();

  sandbox.stub(IPProtectionService.guardian, "fetchProxyPass").resolves({
    status: 429,
    error: "quota_exceeded",
    pass: undefined,
    usage: new ProxyUsage("5368709120", "0", "2026-02-02T00:00:00.000Z"),
  });

  // Initialize service and wait for READY state
  const readyEvent = waitForEvent(
    IPProtectionService,
    "IPProtectionService:StateChanged",
    () => IPProtectionService.state === IPProtectionStates.READY
  );

  IPProtectionService.init();
  await readyEvent;

  // Setup event listener to capture usage change
  let usageChanged = false;
  let capturedUsage = null;
  const usageListener = event => {
    usageChanged = true;
    capturedUsage = event.detail.usage;
  };
  IPPProxyManager.addEventListener(
    "IPPProxyManager:UsageChanged",
    usageListener
  );

  // Try to start - should fail but still set usage
  try {
    await IPPProxyManager.start();
  } catch (error) {
    // Expected to fail
  }

  // Verify usage was set before error
  Assert.ok(usageChanged, "UsageChanged event should have fired");
  Assert.notEqual(capturedUsage, null, "Usage should be captured");
  Assert.equal(
    capturedUsage.remaining,
    BigInt("0"),
    "Usage remaining should be 0"
  );
  Assert.equal(
    capturedUsage.max,
    BigInt("5368709120"),
    "Usage max should be set"
  );

  // Verify the proxy is in ERROR state because no pass was available
  Assert.equal(
    IPPProxyManager.state,
    IPPProxyStates.ERROR,
    "Should be in ERROR state"
  );

  // Verify usage is still accessible in manager
  Assert.notEqual(IPPProxyManager.usageInfo, null, "Usage should be stored");
  Assert.equal(
    IPPProxyManager.usageInfo.remaining,
    BigInt("0"),
    "Stored usage remaining should be 0"
  );
  Assert.equal(
    IPPProxyManager.usageInfo.max,
    BigInt("5368709120"),
    "Stored usage max should be set"
  );

  // Cleanup
  IPPProxyManager.removeEventListener(
    "IPPProxyManager:UsageChanged",
    usageListener
  );
  IPProtectionService.uninit();
  sandbox.restore();
});

/**
 * Tests the active state.
 */
add_task(async function test_IPPProxytates_active() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(IPPSignInWatcher, "isSignedIn").get(() => true);
  sandbox
    .stub(IPProtectionService.guardian, "isLinkedToGuardian")
    .resolves(true);
  sandbox.stub(IPProtectionService.guardian, "fetchUserInfo").resolves({
    status: 200,
    error: undefined,
    entitlement: createTestEntitlement(),
  });
  sandbox.stub(IPProtectionService.guardian, "fetchProxyPass").resolves({
    status: 200,
    error: undefined,
    pass: new ProxyPass(
      options.validProxyPass
        ? createProxyPassToken()
        : createExpiredProxyPassToken()
    ),
    usage: new ProxyUsage(
      "5368709120",
      "4294967296",
      "2026-02-01T00:00:00.000Z"
    ),
  });

  const waitForReady = waitForEvent(
    IPProtectionService,
    "IPProtectionService:StateChanged",
    () => IPProtectionService.state === IPProtectionStates.READY
  );

  IPProtectionService.init();

  await waitForReady;

  Assert.equal(
    IPProtectionService.state,
    IPProtectionStates.READY,
    "IP Protection service should be ready"
  );

  const startPromise = IPPProxyManager.start(false);

  Assert.equal(
    IPPProxyManager.state,
    IPPProxyStates.ACTIVATING,
    "Proxy activation"
  );

  await startPromise;

  Assert.equal(
    IPProtectionService.state,
    IPProtectionStates.READY,
    "IP Protection service should be in ready state"
  );

  Assert.equal(
    IPPProxyManager.state,
    IPPProxyStates.ACTIVE,
    "IP Protection service should be active"
  );

  await IPPProxyManager.stop(false);

  Assert.equal(
    IPProtectionService.state,
    IPProtectionStates.READY,
    "IP Protection service should be ready again"
  );

  IPProtectionService.uninit();
  sandbox.restore();
});

/**
 * Tests the quick start/stop calls.
 */
add_task(async function test_IPPProxytates_start_stop() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(IPPSignInWatcher, "isSignedIn").get(() => true);
  sandbox
    .stub(IPProtectionService.guardian, "isLinkedToGuardian")
    .resolves(true);
  sandbox.stub(IPProtectionService.guardian, "fetchUserInfo").resolves({
    status: 200,
    error: undefined,
    entitlement: createTestEntitlement(),
  });
  sandbox.stub(IPProtectionService.guardian, "fetchProxyPass").resolves({
    status: 200,
    error: undefined,
    pass: new ProxyPass(
      options.validProxyPass
        ? createProxyPassToken()
        : createExpiredProxyPassToken()
    ),
    usage: new ProxyUsage(
      "5368709120",
      "4294967296",
      "2026-02-01T00:00:00.000Z"
    ),
  });

  const waitForReady = waitForEvent(
    IPProtectionService,
    "IPProtectionService:StateChanged",
    () => IPProtectionService.state === IPProtectionStates.READY
  );

  IPProtectionService.init();

  await waitForReady;

  Assert.equal(
    IPProtectionService.state,
    IPProtectionStates.READY,
    "IP Protection service should be ready"
  );

  IPPProxyManager.start(false);
  IPPProxyManager.start(false);
  IPPProxyManager.start(false);

  IPPProxyManager.stop(false);
  IPPProxyManager.stop(false);
  IPPProxyManager.stop(false);
  IPPProxyManager.stop(false);

  Assert.equal(
    IPPProxyManager.state,
    IPPProxyStates.ACTIVATING,
    "Proxy activation"
  );

  await waitForEvent(
    IPPProxyManager,
    "IPPProxyManager:StateChanged",
    () => IPPProxyManager.state === IPPProxyStates.ACTIVE
  );

  await waitForEvent(
    IPPProxyManager,
    "IPPProxyManager:StateChanged",
    () => IPPProxyManager.state === IPPProxyStates.READY
  );

  IPProtectionService.uninit();
  sandbox.restore();
});

add_task(async function test_IPPProxyManager_restores_cached_usage() {
  Services.prefs.setBoolPref("browser.ipProtection.cacheDisabled", false);

  const { ProxyUsage } = ChromeUtils.importESModule(
    "moz-src:///browser/components/ipprotection/GuardianClient.sys.mjs"
  );
  const { IPPStartupCache } = ChromeUtils.importESModule(
    "moz-src:///browser/components/ipprotection/IPPStartupCache.sys.mjs"
  );

  const cachedUsage = new ProxyUsage(
    "5000000000",
    "2500000000",
    "2026-03-01T00:00:00Z"
  );
  IPPStartupCache.storeUsageInfo(cachedUsage);

  const { IPPProxyManager } = ChromeUtils.importESModule(
    "moz-src:///browser/components/ipprotection/IPPProxyManager.sys.mjs"
  );
  IPPProxyManager.init();

  const loadedUsage = IPPProxyManager.usageInfo;
  Assert.notEqual(loadedUsage, null, "Manager loaded usage from cache");
  Assert.equal(
    loadedUsage.max.toString(),
    cachedUsage.max.toString(),
    "Cached max loaded correctly"
  );
  Assert.equal(
    loadedUsage.remaining.toString(),
    cachedUsage.remaining.toString(),
    "Cached remaining loaded correctly"
  );
  Assert.equal(
    loadedUsage.reset.toString(),
    cachedUsage.reset.toString(),
    "Cached reset loaded correctly"
  );

  Services.prefs.clearUserPref("browser.ipProtection.usageCache");
});
