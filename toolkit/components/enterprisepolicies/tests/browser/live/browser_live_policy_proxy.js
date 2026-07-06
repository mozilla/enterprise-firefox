/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";
/* eslint-disable mozilla/reject-import-preferences-module */
const { Preferences } = ChromeUtils.importESModule(
  "resource://gre/modules/Preferences.sys.mjs"
);
/* eslint-enable mozilla/reject-import-preferences-module */

function checkLockedPref(prefName, prefValue) {
  Assert.equal(
    Preferences.locked(prefName),
    true,
    `Pref ${prefName} is correctly locked`
  );
  Assert.strictEqual(
    Preferences.get(prefName),
    prefValue,
    `Pref ${prefName} has the correct value`
  );
}

function checkUnlockedPref(prefName, prefValue) {
  Assert.equal(
    Preferences.locked(prefName),
    false,
    `Pref ${prefName} is correctly unlocked`
  );
  Assert.strictEqual(
    Preferences.get(prefName),
    prefValue,
    `Pref ${prefName} has the correct value`
  );
}

function checkProxyPref(proxytype, address, port, unlocked = true) {
  if (unlocked) {
    checkUnlockedPref(`network.proxy.${proxytype}`, address);
    checkUnlockedPref(`network.proxy.${proxytype}_port`, port);
  } else {
    checkLockedPref(`network.proxy.${proxytype}`, address);
    checkLockedPref(`network.proxy.${proxytype}_port`, port);
  }
}

add_task(async function test_apply_then_remove_proxy() {
  // Assert proxy settings are not set
  checkProxyPref("http", "", 0);
  checkProxyPref("ssl", "", 0);
  // SOCKS proxy should NOT be overwritten with UseHTTPProxyForAllProtocols
  checkProxyPref("socks", "", 0);

  is(
    Services.policies.isAllowed("changeProxySettings"),
    true,
    "changeProxySettings is allowed"
  );

  info("Setting up policy engine.");
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        Proxy: {
          HTTPProxy: "http.proxy.example.com:10",
          SSLProxy: "ssl.proxy.example.com:30",
          SOCKSProxy: "socks.proxy.example.com:40",
          UseHTTPProxyForAllProtocols: true,
        },
      },
    },
    null
  );

  // Assert proxy settings are set
  checkProxyPref("http", "http.proxy.example.com", 10);
  checkProxyPref("ssl", "http.proxy.example.com", 10);
  // SOCKS proxy should NOT be overwritten with UseHTTPProxyForAllProtocols
  checkProxyPref("socks", "socks.proxy.example.com", 40);

  is(
    Services.policies.isAllowed("changeProxySettings"),
    true,
    "changeProxySettings is allowed"
  );

  // Remove Proxy policy
  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies({
    policies: {},
  });
  await updateApplied;

  // Assert proxy settings are removed
  checkProxyPref("http", "", 0);
  checkProxyPref("ssl", "", 0);
  // SOCKS proxy should NOT be overwritten with UseHTTPProxyForAllProtocols
  checkProxyPref("socks", "", 0);

  is(
    Services.policies.isAllowed("changeProxySettings"),
    true,
    "changeProxySettings is allowed"
  );
});

add_task(async function test_apply_then_remove_proxy_locked() {
  // Assert proxy settings are not set
  checkProxyPref("http", "", 0);
  checkProxyPref("ssl", "", 0);
  // SOCKS proxy should NOT be overwritten with UseHTTPProxyForAllProtocols
  checkProxyPref("socks", "", 0);

  is(
    Services.policies.isAllowed("changeProxySettings"),
    true,
    "changeProxySettings is allowed"
  );

  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        Proxy: {
          HTTPProxy: "http.proxy.example.com:10",
          SSLProxy: "ssl.proxy.example.com:30",
          SOCKSProxy: "socks.proxy.example.com:40",
          UseHTTPProxyForAllProtocols: true,
          Locked: true,
        },
      },
    },
    null
  );

  // Assert proxy settings are set
  checkProxyPref("http", "http.proxy.example.com", 10, false);
  checkProxyPref("ssl", "http.proxy.example.com", 10, false);
  // SOCKS proxy should NOT be overwritten with UseHTTPProxyForAllProtocols
  checkProxyPref("socks", "socks.proxy.example.com", 40, false);

  is(
    Services.policies.isAllowed("changeProxySettings"),
    false,
    "changeProxySettings is blocked"
  );

  // Remove Proxy policy
  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies({
    policies: {},
  });
  await updateApplied;

  // Assert proxy settings are removed
  checkProxyPref("http", "", 0);
  checkProxyPref("ssl", "", 0);
  // SOCKS proxy should NOT be overwritten with UseHTTPProxyForAllProtocols
  checkProxyPref("socks", "", 0);

  is(
    Services.policies.isAllowed("changeProxySettings"),
    true,
    "changeProxySettings is allowed"
  );
});

add_task(async function test_apply_proxy_then_change_proxy() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        Proxy: {
          HTTPProxy: "http.proxy.example.com:10",
          SSLProxy: "ssl.proxy.example.com:30",
          SOCKSProxy: "socks.proxy.example.com:40",
          UseHTTPProxyForAllProtocols: true,
        },
      },
    },
    null
  );

  // Assert proxy settings are set
  checkProxyPref("http", "http.proxy.example.com", 10);
  checkProxyPref("ssl", "http.proxy.example.com", 10);
  // SOCKS proxy should NOT be overwritten with UseHTTPProxyForAllProtocols
  checkProxyPref("socks", "socks.proxy.example.com", 40);

  is(
    Services.policies.isAllowed("changeProxySettings"),
    true,
    "changeProxySettings is allowed"
  );

  // Network change from device posture? New policy
  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies({
    policies: {
      Proxy: {
        HTTPProxy: "http.proxy2.example.com:10",
        SSLProxy: "ssl.proxy2.example.com:30",
        SOCKSProxy: "socks.proxy2.example.com:40",
        UseHTTPProxyForAllProtocols: true,
      },
    },
  });
  await updateApplied;

  // Assert proxy settings are set
  checkProxyPref("http", "http.proxy2.example.com", 10);
  checkProxyPref("ssl", "http.proxy2.example.com", 10);
  // SOCKS proxy should NOT be overwritten with UseHTTPProxyForAllProtocols
  checkProxyPref("socks", "socks.proxy2.example.com", 40);

  is(
    Services.policies.isAllowed("changeProxySettings"),
    true,
    "changeProxySettings is allowed"
  );
});
