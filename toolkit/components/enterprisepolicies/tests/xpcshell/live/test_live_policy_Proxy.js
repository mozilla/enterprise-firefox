/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// This is deliberately an xpcshell test, not browser-chrome. It drives
// nsIProtocolProxyService to prove the Proxy policy actually affects proxy
// resolution when applied, updated and removed live. The browser-chrome harness
// routes its own traffic through a PAC proxy configured as user prefs, while
// the policy sets the same network.proxy.* prefs on the default branch. There
// the policy would either be shadowed by the harness' user prefs (unlocked) or
// clobber the harness' own routing (locked) - so resolution can only be tested
// meaningfully in xpcshell, which has no competing proxy setup.

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);
const { ConsoleProxyBypassFilter } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/enterprise/modules/ConsoleProxyBypassFilter.sys.mjs"
);

const pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(
  Ci.nsIProtocolProxyService
);

function resolveProxy(uri) {
  const channel = NetUtil.newChannel({
    uri,
    loadUsingSystemPrincipal: true,
  });
  return new Promise(resolve => {
    pps.asyncResolve(channel, 0, {
      QueryInterface: ChromeUtils.generateQI(["nsIProtocolProxyCallback"]),
      onProxyAvailable(_req, _channel, proxyInfo) {
        resolve(proxyInfo);
      },
    });
  });
}

function checkResolvedProxy(proxyInfo, type, host, port, message) {
  Assert.notEqual(proxyInfo, null, `${message}: a proxy is resolved`);
  Assert.equal(proxyInfo.type, type, `${message}: correct type`);
  Assert.equal(proxyInfo.host, host, `${message}: correct host`);
  Assert.equal(proxyInfo.port, port, `${message}: correct port`);
}

function checkNotProxiedThrough(proxyInfo, message) {
  // A direct connection resolves to a null proxy info
  Assert.equal(proxyInfo, null, `${message}: no longer proxied`);
}

add_task(async function test_proxy_applied_updated_removed_live() {
  checkNotProxiedThrough(
    await resolveProxy("http://example.com/"),
    "not proxied"
  );

  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        Proxy: {
          Mode: "manual",
          HTTPProxy: "proxy.example.com:8080",
        },
      },
    },
    null
  );

  checkResolvedProxy(
    await resolveProxy("http://example.com/"),
    "http",
    "proxy.example.com",
    8080,
    "policy applied"
  );

  let updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies({
    policies: {
      Proxy: {
        Mode: "manual",
        HTTPProxy: "proxy2.example.com:9090",
      },
    },
  });
  await updateApplied;

  checkResolvedProxy(
    await resolveProxy("http://example.com/"),
    "http",
    "proxy2.example.com",
    9090,
    "policy updated live"
  );

  updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });
  await updateApplied;

  checkNotProxiedThrough(
    await resolveProxy("http://example.com/"),
    "policy removed live"
  );
  Assert.equal(
    Services.prefs.getIntPref("network.proxy.type"),
    5,
    "network.proxy.type restored to its default"
  );
  Assert.equal(
    Services.prefs.getStringPref("network.proxy.http"),
    "",
    "network.proxy.http restored to its default"
  );
});

add_task(async function test_locked_proxy_enforced_and_released_live() {
  checkNotProxiedThrough(
    await resolveProxy("http://example.com/"),
    "not proxied"
  );

  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        Proxy: {
          Mode: "manual",
          HTTPProxy: "proxy.example.com:8080",
          Locked: true,
        },
      },
    },
    null
  );

  checkResolvedProxy(
    await resolveProxy("http://example.com/"),
    "http",
    "proxy.example.com",
    8080,
    "locked policy applied"
  );
  Assert.ok(
    Services.prefs.prefIsLocked("network.proxy.http"),
    "network.proxy.http is locked"
  );
  Assert.equal(
    Services.policies.isAllowed("changeProxySettings"),
    false,
    "changeProxySettings is blocked while locked"
  );

  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });
  await updateApplied;

  Assert.ok(
    !Services.prefs.prefIsLocked("network.proxy.http"),
    "network.proxy.http is unlocked after removal"
  );
  Assert.equal(
    Services.policies.isAllowed("changeProxySettings"),
    true,
    "changeProxySettings is allowed after removal"
  );
  checkNotProxiedThrough(
    await resolveProxy("http://example.com/"),
    "locked policy removed live"
  );
});

add_task(async function test_use_http_proxy_for_all_protocols_live() {
  checkNotProxiedThrough(
    await resolveProxy("http://example.com/"),
    "not proxied"
  );

  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        Proxy: {
          Mode: "manual",
          HTTPProxy: "proxy.example.com:8080",
          SOCKSProxy: "socks.example.com:1080",
          UseHTTPProxyForAllProtocols: true,
        },
      },
    },
    null
  );

  // Both HTTP and HTTPS route through the HTTP proxy (an SSL/TLS target still
  // resolves to an "http" proxy, i.e. a CONNECT proxy).
  checkResolvedProxy(
    await resolveProxy("http://example.com/"),
    "http",
    "proxy.example.com",
    8080,
    "http routed through the HTTP proxy"
  );
  checkResolvedProxy(
    await resolveProxy("https://example.com/"),
    "http",
    "proxy.example.com",
    8080,
    "https routed through the HTTP proxy"
  );
  // The SOCKS proxy is deliberately left untouched.
  Assert.equal(
    Services.prefs.getStringPref("network.proxy.socks"),
    "socks.example.com",
    "SOCKS proxy is not overwritten"
  );

  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });
  await updateApplied;

  checkNotProxiedThrough(
    await resolveProxy("http://example.com/"),
    "http released after removal"
  );
  checkNotProxiedThrough(
    await resolveProxy("https://example.com/"),
    "https released after removal"
  );
});

add_task(async function test_ssl_proxy_applied_and_removed_live() {
  checkNotProxiedThrough(
    await resolveProxy("https://example.com/"),
    "not proxied"
  );

  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        Proxy: {
          Mode: "manual",
          SSLProxy: "ssl.example.com:8443",
        },
      },
    },
    null
  );

  // HTTPS routes through the SSL proxy; resolved as an "http" CONNECT proxy ...
  checkResolvedProxy(
    await resolveProxy("https://example.com/"),
    "http",
    "ssl.example.com",
    8443,
    "https routed through the SSL proxy"
  );
  // ...while plain HTTP is not, proving the proxy is SSL-specific.
  checkNotProxiedThrough(
    await resolveProxy("http://example.com/"),
    "http is not routed through the SSL proxy"
  );

  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });
  await updateApplied;

  checkNotProxiedThrough(
    await resolveProxy("https://example.com/"),
    "SSL policy removed live"
  );
});

add_task(async function test_passthrough_bypasses_proxy_live() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        Proxy: {
          Mode: "manual",
          HTTPProxy: "proxy.example.com:8080",
          Passthrough: "example.net",
        },
      },
    },
    null
  );

  // A host outside the passthrough domain is proxied...
  checkResolvedProxy(
    await resolveProxy("http://example.com/"),
    "http",
    "proxy.example.com",
    8080,
    "host outside the passthrough domain is proxied"
  );
  // ...while the passthrough domain and any subdomain of it bypass the proxy.
  checkNotProxiedThrough(
    await resolveProxy("http://example.net/"),
    "passthrough domain bypasses the proxy"
  );
  checkNotProxiedThrough(
    await resolveProxy("http://sub.example.net/"),
    "passthrough subdomain bypasses the proxy"
  );

  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });
  await updateApplied;

  checkNotProxiedThrough(
    await resolveProxy("http://example.com/"),
    "passthrough policy removed live"
  );
});

add_task(async function test_socks_proxy_applied_and_removed_live() {
  checkNotProxiedThrough(
    await resolveProxy("http://example.com/"),
    "not proxied"
  );

  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        Proxy: {
          Mode: "manual",
          SOCKSProxy: "socks.example.com:1080",
          SOCKSVersion: 4,
        },
      },
    },
    null
  );

  checkResolvedProxy(
    await resolveProxy("http://example.com/"),
    "socks4",
    "socks.example.com",
    1080,
    "SOCKS v4 policy applied"
  );

  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });
  await updateApplied;

  checkNotProxiedThrough(
    await resolveProxy("http://example.com/"),
    "SOCKS policy removed live"
  );
});

add_task(async function test_autoconfig_proxy_applied_and_removed_live() {
  checkNotProxiedThrough(
    await resolveProxy("http://example.com/"),
    "not proxied"
  );

  // The policy schema requires AutoConfigURL to be a real URI,
  // so serve the PAC from an in-process server.
  const server = new HttpServer();
  server.registerPathHandler("/proxy.pac", (req, resp) => {
    resp.setHeader("Content-Type", "application/x-ns-proxy-autoconfig", false);
    resp.write(
      "function FindProxyForURL(url, host) {" +
        "  return 'PROXY pac.example.com:3128; DIRECT';" +
        "}"
    );
  });
  server.start(-1);
  const pacUrl = `http://localhost:${server.identity.primaryPort}/proxy.pac`;
  registerCleanupFunction(() => server.stop());

  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        Proxy: {
          Mode: "autoConfig",
          AutoConfigURL: pacUrl,
        },
      },
    },
    null
  );

  // The PAC is fetched and compiled asynchronously, so poll until it is live.
  let proxyInfo;
  await TestUtils.waitForCondition(async () => {
    proxyInfo = await resolveProxy("http://example.com/");
    return proxyInfo?.host === "pac.example.com";
  }, "PAC finished loading and resolves to the configured proxy");
  checkResolvedProxy(
    proxyInfo,
    "http",
    "pac.example.com",
    3128,
    "autoConfig (PAC) policy applied"
  );

  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });
  await updateApplied;

  checkNotProxiedThrough(
    await resolveProxy("http://example.com/"),
    "autoConfig policy removed live"
  );
});

add_task(async function test_console_address_excluded_from_proxy() {
  checkNotProxiedThrough(
    await resolveProxy("http://example.com/"),
    "not proxied"
  );

  // ConsoleClient only registers the bypass filter in the Felt browser, so
  // register it directly here.
  ConsoleProxyBypassFilter.register("console.example.com");
  registerCleanupFunction(() => ConsoleProxyBypassFilter.unregister());

  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        Proxy: {
          Mode: "manual",
          HTTPProxy: "proxy.example.com:8080",
        },
      },
    },
    null
  );

  checkResolvedProxy(
    await resolveProxy("http://example.com/"),
    "http",
    "proxy.example.com",
    8080,
    "regular host is proxied"
  );
  checkNotProxiedThrough(
    await resolveProxy("http://console.example.com/"),
    "enterprise console is reached directly"
  );

  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });
  await updateApplied;

  checkNotProxiedThrough(
    await resolveProxy("http://example.com/"),
    "not proxied"
  );
  checkNotProxiedThrough(
    await resolveProxy("http://console.example.com/"),
    "enterprise console is still reached directly"
  );
});
