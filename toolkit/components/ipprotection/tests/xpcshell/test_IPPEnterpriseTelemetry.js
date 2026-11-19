/* Any copyright is dedicated to the Public Domain.
https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { IPPEnterpriseTelemetrySingleton } = ChromeUtils.importESModule(
  "resource://testing-common/ipprotection/IPPEnterpriseTelemetry.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

const ISOLATION_KEY = "access-connector-key";

let connectionIsolationKey = ISOLATION_KEY;
let proxyActive = true;
let proxyState = IPPProxyStates.ACTIVE;
let stopOnError = false;

do_get_profile();
Services.fog.initializeFOG();

/**
 * A finished top-level document channel stub.
 *
 * @param {string} host
 * @param {object} [options]
 * @param {number} [options.status] - The channel's final status.
 * @param {?string} [options.isolationKey] - The proxy connection's isolation
 *   key, or null when the channel was not proxied.
 * @param {number} [options.type] - The external content policy type.
 * @param {number} [options.proxyConnectResponseCode] - The proxy's response
 *   to the CONNECT request.
 * @param {boolean} [options.fromCache] - Whether the page came from the cache.
 */
function makeFinishedChannel(
  host,
  {
    status = Cr.NS_OK,
    isolationKey = ISOLATION_KEY,
    type = Ci.nsIContentPolicy.TYPE_DOCUMENT,
    proxyConnectResponseCode = 200,
    fromCache = false,
  } = {}
) {
  return {
    QueryInterface: ChromeUtils.generateQI([
      Ci.nsIHttpChannel,
      Ci.nsIProxiedChannel,
      Ci.nsICacheInfoChannel,
    ]),
    getCacheDisposition: () =>
      fromCache
        ? Ci.nsICacheInfoChannel.kCacheHit
        : Ci.nsICacheInfoChannel.kCacheMissed,
    URI: Services.io.newURI(`https://${host}/page`),
    status,
    loadInfo: { externalContentPolicyType: type },
    proxyInfo: isolationKey ? { connectionIsolationKey: isolationKey } : null,
    httpProxyConnectResponseCode: proxyConnectResponseCode,
  };
}

/**
 * A top-level document channel that IPPChannelFilter cancelled before it
 * reached a proxy, as it does while the connection is failed.
 *
 * @param {string} host
 * @param {number} [status]
 * @returns {nsIHttpChannel}
 */
function makeCancelledChannel(
  host,
  status = Cr.NS_ERROR_PROXY_CONNECTION_REFUSED
) {
  const channel = NetUtil.newChannel({
    uri: `https://${host}/page`,
    loadUsingSystemPrincipal: true,
    contentPolicyType: Ci.nsIContentPolicy.TYPE_DOCUMENT,
  }).QueryInterface(Ci.nsIHttpChannel);
  channel.cancel(status);
  return channel;
}

/**
 * Runs an action and returns the domains of one metric's events in the
 * enterprise ping it submits, or an empty array if it submits none.
 * Submitting clears the ping's events, so they are read in the submit
 * callback.
 *
 * @param {Function} action - Expected to submit at most once.
 * @param {object} [metric] - The event metric to read.
 * @returns {string[]}
 */
function domainsSubmittedDuring(
  action,
  metric = Glean.accessConnector.domainAccessStarted
) {
  let domains = [];
  GleanPings.enterprise.testBeforeNextSubmit(() => {
    domains = (metric.testGetValue("enterprise") ?? []).map(
      event => event.extra.domain
    );
  });
  action();
  return domains;
}

function errorDomainsSubmittedDuring(action) {
  return domainsSubmittedDuring(action, Glean.accessConnector.proxyError);
}

function setProxyState(state) {
  const prevState = proxyState;
  proxyState = state;
  IPPProxyManager.dispatchEvent(
    new CustomEvent("IPPProxyManager:StateChanged", {
      detail: { state, prevState },
    })
  );
}

function stopRequest(telemetry, channel) {
  telemetry.observe(channel, "http-on-stop-request");
}

function isObserving(telemetry) {
  return [...Services.obs.enumerateObservers("http-on-stop-request")].some(
    observer => observer.wrappedJSObject === telemetry
  );
}

add_setup(function () {
  const sandbox = sinon.createSandbox();
  sandbox
    .stub(IPPProxyManager, "isolationKey")
    .get(() => connectionIsolationKey);
  sandbox.stub(IPPProxyManager, "active").get(() => proxyActive);
  sandbox.stub(IPPProxyManager, "state").get(() => proxyState);

  // Registered before any telemetry instance, as IPProtectionActivator
  // initializes IPPAlwaysOn first, so it stops the proxy from inside the
  // ERROR notification before telemetry receives it.
  const alwaysOnStop = ({ detail }) => {
    if (stopOnError && detail.state === IPPProxyStates.ERROR) {
      proxyActive = false;
      setProxyState(IPPProxyStates.READY);
    }
  };
  IPPProxyManager.addEventListener(
    "IPPProxyManager:StateChanged",
    alwaysOnStop
  );
  registerCleanupFunction(() => {
    IPPProxyManager.removeEventListener(
      "IPPProxyManager:StateChanged",
      alwaysOnStop
    );
    sandbox.restore();
  });
});

add_task(function test_first_load_per_domain_is_recorded() {
  Services.fog.testResetFOG();
  const telemetry = new IPPEnterpriseTelemetrySingleton();
  telemetry.init();

  Assert.deepEqual(
    domainsSubmittedDuring(() =>
      stopRequest(telemetry, makeFinishedChannel("app.corp.example"))
    ),
    ["app.corp.example"],
    "First load of a domain submits its host"
  );
  Assert.deepEqual(
    domainsSubmittedDuring(() =>
      stopRequest(telemetry, makeFinishedChannel("app.corp.example"))
    ),
    [],
    "Later loads of the same domain submit nothing"
  );
  Assert.deepEqual(
    domainsSubmittedDuring(() =>
      stopRequest(telemetry, makeFinishedChannel("wiki.corp.example"))
    ),
    ["wiki.corp.example"],
    "First load of another domain submits its host"
  );
  telemetry.uninit();
});

add_task(function test_ignored_loads() {
  Services.fog.testResetFOG();
  const telemetry = new IPPEnterpriseTelemetrySingleton();
  telemetry.init();
  const cases = [
    [
      "subresource",
      makeFinishedChannel("app.corp.example", {
        type: Ci.nsIContentPolicy.TYPE_SCRIPT,
      }),
    ],
    [
      "subframe",
      makeFinishedChannel("app.corp.example", {
        type: Ci.nsIContentPolicy.TYPE_SUBDOCUMENT,
      }),
    ],
    [
      "not proxied",
      makeFinishedChannel("app.corp.example", { isolationKey: null }),
    ],
    [
      "another proxy connection",
      makeFinishedChannel("app.corp.example", { isolationKey: "other" }),
    ],
    [
      "proxy failure",
      makeFinishedChannel("app.corp.example", {
        status: Cr.NS_ERROR_PROXY_CONNECTION_REFUSED,
      }),
    ],
    [
      "rejected tunnel",
      makeFinishedChannel("app.corp.example", {
        proxyConnectResponseCode: 502,
      }),
    ],
    [
      "redirect",
      makeFinishedChannel("app.corp.example", {
        status: Cr.NS_BINDING_REDIRECTED,
      }),
    ],
  ];

  for (const [name, channel] of cases) {
    Assert.deepEqual(
      domainsSubmittedDuring(() => stopRequest(telemetry, channel)),
      [],
      `A ${name} load submits nothing`
    );
  }

  Assert.deepEqual(
    domainsSubmittedDuring(() =>
      stopRequest(telemetry, makeFinishedChannel("app.corp.example"))
    ),
    ["app.corp.example"],
    "Ignored loads do not mark the domain as reported"
  );
  telemetry.uninit();
});

add_task(function test_ignores_loads_without_connection() {
  Services.fog.testResetFOG();
  const telemetry = new IPPEnterpriseTelemetrySingleton();

  connectionIsolationKey = undefined;
  telemetry.init();
  try {
    Assert.deepEqual(
      domainsSubmittedDuring(() =>
        stopRequest(telemetry, makeFinishedChannel("app.corp.example"))
      ),
      [],
      "Loads submit nothing when there is no proxy connection"
    );
  } finally {
    telemetry.uninit();
    connectionIsolationKey = ISOLATION_KEY;
  }
});

add_task(function test_observes_only_while_proxy_active() {
  proxyActive = false;
  const telemetry = new IPPEnterpriseTelemetrySingleton();

  telemetry.init();
  Assert.ok(
    !isObserving(telemetry),
    "Not observing while the proxy is inactive"
  );

  proxyActive = true;
  setProxyState(IPPProxyStates.ACTIVE);
  Assert.ok(isObserving(telemetry), "Observing while the proxy is active");

  proxyActive = false;
  setProxyState(IPPProxyStates.READY);
  Assert.ok(!isObserving(telemetry), "Stops observing when the proxy stops");

  proxyActive = true;
  setProxyState(IPPProxyStates.ACTIVE);
  telemetry.uninit();
  Assert.ok(!isObserving(telemetry), "Stops observing on uninit");
});

add_task(function test_reports_again_after_reconnect() {
  Services.fog.testResetFOG();
  const telemetry = new IPPEnterpriseTelemetrySingleton();
  telemetry.init();

  const load = () =>
    domainsSubmittedDuring(() =>
      stopRequest(telemetry, makeFinishedChannel("app.corp.example"))
    );

  Assert.deepEqual(load(), ["app.corp.example"], "First load is submitted");

  setProxyState(IPPProxyStates.ACTIVE);
  Assert.deepEqual(load(), [], "A state event while active does not reset");

  for (const interruption of [
    IPPProxyStates.ERROR,
    IPPProxyStates.PAUSED,
    IPPProxyStates.READY,
  ]) {
    setProxyState(interruption);
    setProxyState(IPPProxyStates.ACTIVE);
    Assert.deepEqual(
      load(),
      ["app.corp.example"],
      `Load is submitted again after reconnecting from ${interruption}`
    );
  }

  telemetry.uninit();
});

add_task(function test_retains_keys_across_rotation() {
  Services.fog.testResetFOG();
  const telemetry = new IPPEnterpriseTelemetrySingleton();
  telemetry.init();

  const load = (domain, isolationKey) =>
    domainsSubmittedDuring(() =>
      stopRequest(telemetry, makeFinishedChannel(domain, { isolationKey }))
    );
  const rotate = isolationKey => {
    connectionIsolationKey = isolationKey;
    IPPProxyManager.dispatchEvent(
      new CustomEvent("IPPProxyManager:IsolationKeyAdded", {
        detail: { isolationKey },
      })
    );
  };

  try {
    connectionIsolationKey = null;
    Assert.ok(isObserving(telemetry), "Still observing during suspension");
    Assert.deepEqual(
      load("during.corp.example", ISOLATION_KEY),
      ["during.corp.example"],
      "An old-key load finishing during suspension is recorded"
    );

    rotate("rotated-key");
    Assert.deepEqual(
      load("after.corp.example", ISOLATION_KEY),
      ["after.corp.example"],
      "An old-key load finishing after rotation is recorded"
    );
    rotate("next-key");
    Assert.deepEqual(
      load("after.corp.example", "next-key"),
      [],
      "Rotation preserves domain deduplication"
    );

    Assert.deepEqual(
      load("delayed.corp.example", "rotated-key"),
      ["delayed.corp.example"],
      "A key is retained even if its first completion follows another rotation"
    );
    Assert.deepEqual(
      load("new.corp.example", "next-key"),
      ["new.corp.example"],
      "The current key is accepted"
    );

    proxyActive = false;
    connectionIsolationKey = null;
    setProxyState(IPPProxyStates.READY);
    proxyActive = true;
    connectionIsolationKey = "reconnected-key";
    setProxyState(IPPProxyStates.ACTIVE);

    for (const key of [ISOLATION_KEY, "rotated-key", "next-key"]) {
      Assert.deepEqual(
        load("stale.corp.example", key),
        [],
        "Keys from the previous logical connection are rejected"
      );
    }
    Assert.deepEqual(
      load("after.corp.example", "reconnected-key"),
      ["after.corp.example"],
      "Reconnection resets domain deduplication"
    );

    telemetry.uninit();
    connectionIsolationKey = "unobserved-key";
    IPPProxyManager.dispatchEvent(
      new CustomEvent("IPPProxyManager:IsolationKeyAdded", {
        detail: { isolationKey: connectionIsolationKey },
      })
    );
    connectionIsolationKey = "another-key";
    telemetry.init();
    Assert.deepEqual(
      load("late.corp.example", "unobserved-key"),
      [],
      "Keys announced while uninitialized are ignored"
    );
    Assert.deepEqual(
      load("late.corp.example", "reconnected-key"),
      [],
      "Uninit clears retained keys"
    );
    Assert.deepEqual(
      load("late.corp.example", "another-key"),
      ["late.corp.example"],
      "Reinitializing captures the current key"
    );
  } finally {
    telemetry.uninit();
    connectionIsolationKey = ISOLATION_KEY;
    proxyState = IPPProxyStates.ACTIVE;
    proxyActive = true;
  }
});

add_task(function test_limits_retained_keys() {
  Services.fog.testResetFOG();
  const telemetry = new IPPEnterpriseTelemetrySingleton();
  telemetry.init();

  const load = (domain, isolationKey) =>
    domainsSubmittedDuring(() =>
      stopRequest(telemetry, makeFinishedChannel(domain, { isolationKey }))
    );

  try {
    for (let i = 1; i <= 10; i++) {
      connectionIsolationKey = `key-${i}`;
      IPPProxyManager.dispatchEvent(
        new CustomEvent("IPPProxyManager:IsolationKeyAdded", {
          detail: { isolationKey: connectionIsolationKey },
        })
      );
    }

    Assert.deepEqual(
      load("evicted.corp.example", ISOLATION_KEY),
      [],
      "The oldest key is dropped once more than ten are tracked"
    );
    Assert.deepEqual(
      load("oldest.corp.example", "key-1"),
      ["oldest.corp.example"],
      "The oldest retained key is accepted"
    );
    Assert.deepEqual(
      load("current.corp.example", "key-10"),
      ["current.corp.example"],
      "The current key is accepted"
    );
  } finally {
    telemetry.uninit();
    connectionIsolationKey = ISOLATION_KEY;
  }
});

add_task(function test_proxy_failures_are_recorded() {
  Services.fog.testResetFOG();
  const telemetry = new IPPEnterpriseTelemetrySingleton();
  telemetry.init();
  const cases = [
    ["refused.corp.example", { status: Cr.NS_ERROR_PROXY_CONNECTION_REFUSED }],
    ["unresolved.corp.example", { status: Cr.NS_ERROR_UNKNOWN_PROXY_HOST }],
    [
      "gateway.corp.example",
      {
        status: Cr.NS_ERROR_PROXY_BAD_GATEWAY,
        proxyConnectResponseCode: 502,
      },
    ],
    ["rejected.corp.example", { proxyConnectResponseCode: 407 }],
  ];

  for (const [host, options] of cases) {
    Assert.deepEqual(
      errorDomainsSubmittedDuring(() =>
        stopRequest(telemetry, makeFinishedChannel(host, options))
      ),
      [host],
      `A proxy failure for ${host} submits its host`
    );
  }
  telemetry.uninit();
});

add_task(function test_ignored_failures() {
  Services.fog.testResetFOG();
  const telemetry = new IPPEnterpriseTelemetrySingleton();
  telemetry.init();
  const refused = { status: Cr.NS_ERROR_PROXY_CONNECTION_REFUSED };
  const cases = [
    [
      "site failure",
      makeFinishedChannel("app.corp.example", {
        status: Cr.NS_ERROR_CONNECTION_REFUSED,
      }),
    ],
    [
      "untunneled load",
      makeFinishedChannel("app.corp.example", {
        proxyConnectResponseCode: -1,
      }),
    ],
    [
      "subresource",
      makeFinishedChannel("app.corp.example", {
        ...refused,
        type: Ci.nsIContentPolicy.TYPE_SCRIPT,
      }),
    ],
    [
      "unproxied",
      makeFinishedChannel("app.corp.example", {
        ...refused,
        isolationKey: null,
      }),
    ],
    [
      "service worker load",
      {
        ...makeFinishedChannel("app.corp.example", refused),
        QueryInterface: ChromeUtils.generateQI([Ci.nsIHttpChannel]),
      },
    ],
    [
      "another proxy connection",
      makeFinishedChannel("app.corp.example", {
        ...refused,
        isolationKey: "other",
      }),
    ],
    ["cancelled while connected", makeCancelledChannel("app.corp.example")],
  ];

  const getRule = sinon
    .stub(IPPSiteRuleManager, "getRule")
    .returns(IPPPrincipalRules.INCLUDED);
  try {
    for (const [name, channel] of cases) {
      Assert.deepEqual(
        errorDomainsSubmittedDuring(() => stopRequest(telemetry, channel)),
        [],
        `A ${name} submits no proxy error`
      );
    }
  } finally {
    getRule.restore();
    telemetry.uninit();
  }
});

/**
 * Fails the connection the way IPPAlwaysOn handles it: the proxy is stopped
 * while the ERROR notification is still being dispatched, before its
 * cancelled loads finish.
 */
function failAndStopConnection() {
  stopOnError = true;
  try {
    setProxyState(IPPProxyStates.ERROR);
  } finally {
    stopOnError = false;
  }
}

add_task(function test_proxy_errors_reported_once_per_outage() {
  Services.fog.testResetFOG();
  const telemetry = new IPPEnterpriseTelemetrySingleton();
  telemetry.init();
  const fail = (host, isolationKey = ISOLATION_KEY) =>
    errorDomainsSubmittedDuring(() =>
      stopRequest(
        telemetry,
        makeFinishedChannel(host, {
          status: Cr.NS_ERROR_PROXY_CONNECTION_REFUSED,
          isolationKey,
        })
      )
    );

  try {
    Assert.deepEqual(fail("app.corp.example"), ["app.corp.example"]);
    Assert.deepEqual(fail("app.corp.example"), [], "Repeats submit nothing");

    failAndStopConnection();
    Assert.ok(isObserving(telemetry), "Still observing after the stop");
    Assert.deepEqual(
      fail("other.corp.example"),
      ["other.corp.example"],
      "An in-flight load failing after the stop is submitted"
    );
    Assert.deepEqual(
      fail("app.corp.example"),
      [],
      "A domain already reported in this outage submits nothing"
    );
    Assert.deepEqual(
      domainsSubmittedDuring(() =>
        stopRequest(telemetry, makeFinishedChannel("late.corp.example"))
      ),
      [],
      "An in-flight load succeeding after the failure is not recorded"
    );

    setProxyState(IPPProxyStates.ACTIVATING);
    failAndStopConnection();
    Assert.deepEqual(
      fail("app.corp.example"),
      [],
      "A failed retry does not start a new outage"
    );

    proxyActive = true;
    connectionIsolationKey = "reconnected-key";
    setProxyState(IPPProxyStates.ACTIVE);
    Assert.deepEqual(
      fail("new.corp.example"),
      [],
      "Keys from the failed connection are dropped once reconnected"
    );
    Assert.deepEqual(
      fail("app.corp.example", "reconnected-key"),
      [],
      "A domain still failing after a reconnect submits nothing"
    );

    proxyActive = false;
    setProxyState(IPPProxyStates.READY);
    Assert.ok(!isObserving(telemetry), "A normal stop ends observation");
  } finally {
    telemetry.uninit();
    proxyState = IPPProxyStates.ACTIVE;
    proxyActive = true;
    connectionIsolationKey = ISOLATION_KEY;
  }
});

add_task(function test_proxy_errors_reported_again_after_recovery() {
  Services.fog.testResetFOG();
  const telemetry = new IPPEnterpriseTelemetrySingleton();
  telemetry.init();
  const fail = host =>
    errorDomainsSubmittedDuring(() =>
      stopRequest(
        telemetry,
        makeFinishedChannel(host, {
          status: Cr.NS_ERROR_PROXY_CONNECTION_REFUSED,
        })
      )
    );
  const load = (host, options) =>
    stopRequest(telemetry, makeFinishedChannel(host, options));

  try {
    Assert.deepEqual(fail("app.corp.example"), ["app.corp.example"]);

    load("other.corp.example");
    Assert.deepEqual(
      fail("app.corp.example"),
      [],
      "Another domain loading does not end this domain's outage"
    );

    load("app.corp.example", { fromCache: true });
    Assert.deepEqual(
      fail("app.corp.example"),
      [],
      "A page from the cache does not end the outage"
    );

    load("app.corp.example", { isolationKey: null });
    Assert.deepEqual(
      fail("app.corp.example"),
      [],
      "A load that didn't go through the proxy does not end the outage"
    );

    load("app.corp.example");
    Assert.deepEqual(
      fail("app.corp.example"),
      ["app.corp.example"],
      "A failure after the domain loads through the proxy is submitted"
    );
  } finally {
    telemetry.uninit();
  }
});

add_task(function test_failed_connection_cancellations() {
  Services.fog.testResetFOG();
  const telemetry = new IPPEnterpriseTelemetrySingleton();
  telemetry.init();
  const getRule = sinon
    .stub(IPPSiteRuleManager, "getRule")
    .callsFake(principal =>
      principal.host === "excluded.corp.example"
        ? IPPPrincipalRules.EXCLUDED
        : IPPPrincipalRules.INCLUDED
    );
  const cancel = (host, status) =>
    errorDomainsSubmittedDuring(() =>
      stopRequest(telemetry, makeCancelledChannel(host, status))
    );

  try {
    failAndStopConnection();
    Assert.deepEqual(
      cancel("app.corp.example"),
      ["app.corp.example"],
      "A load cancelled for an included site is submitted after the stop"
    );
    Assert.equal(
      getRule.lastCall.args[0].host,
      "app.corp.example",
      "The site rule is looked up for the page"
    );
    Assert.deepEqual(
      cancel("excluded.corp.example"),
      [],
      "A load for a site the Access Connector does not route submits nothing"
    );
    Assert.deepEqual(
      cancel("other.corp.example", Cr.NS_ERROR_UNKNOWN_PROXY_HOST),
      [],
      "A failure the channel filter does not produce submits nothing"
    );

    proxyActive = true;
    setProxyState(IPPProxyStates.ACTIVE);
    Assert.deepEqual(
      cancel("new.corp.example"),
      [],
      "Cancelled loads without a key are not attributed once reconnected"
    );
  } finally {
    getRule.restore();
    telemetry.uninit();
    proxyState = IPPProxyStates.ACTIVE;
    proxyActive = true;
  }
});
