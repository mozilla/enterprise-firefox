/* Any copyright is dedicated to the Public Domain.
https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { IPPEnterpriseTelemetrySingleton } = ChromeUtils.importESModule(
  "resource://testing-common/ipprotection/IPPEnterpriseTelemetry.sys.mjs"
);

const ISOLATION_KEY = "access-connector-key";

let connectionIsolationKey = ISOLATION_KEY;
let proxyActive = true;
let proxyState = IPPProxyStates.ACTIVE;

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
 */
function makeFinishedChannel(
  host,
  {
    status = Cr.NS_OK,
    isolationKey = ISOLATION_KEY,
    type = Ci.nsIContentPolicy.TYPE_DOCUMENT,
    proxyConnectResponseCode = 200,
  } = {}
) {
  return {
    QueryInterface: ChromeUtils.generateQI([
      Ci.nsIHttpChannel,
      Ci.nsIProxiedChannel,
    ]),
    URI: Services.io.newURI(`https://${host}/page`),
    status,
    loadInfo: { externalContentPolicyType: type },
    proxyInfo: isolationKey ? { connectionIsolationKey: isolationKey } : null,
    httpProxyConnectResponseCode: proxyConnectResponseCode,
  };
}

/**
 * Runs an action and returns the domains in the enterprise ping it submits,
 * or an empty array if it submits none. Submitting clears the ping's events,
 * so they are read in the submit callback.
 *
 * @param {Function} action - Expected to submit at most once.
 * @returns {string[]}
 */
function domainsSubmittedDuring(action) {
  let domains = [];
  GleanPings.enterprise.testBeforeNextSubmit(() => {
    domains = (
      Glean.accessConnector.domainAccessed.testGetValue("enterprise") ?? []
    ).map(event => event.extra.domain);
  });
  action();
  return domains;
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
  registerCleanupFunction(() => sandbox.restore());
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
  IPPProxyManager.dispatchEvent(new Event("IPPProxyManager:StateChanged"));
  Assert.ok(isObserving(telemetry), "Observing while the proxy is active");

  proxyActive = false;
  IPPProxyManager.dispatchEvent(new Event("IPPProxyManager:StateChanged"));
  Assert.ok(!isObserving(telemetry), "Stops observing when the proxy stops");

  proxyActive = true;
  IPPProxyManager.dispatchEvent(new Event("IPPProxyManager:StateChanged"));
  telemetry.uninit();
  Assert.ok(!isObserving(telemetry), "Stops observing on uninit");
});

add_task(function test_reports_again_after_reconnect() {
  Services.fog.testResetFOG();
  const telemetry = new IPPEnterpriseTelemetrySingleton();
  telemetry.init();

  const setState = newState => {
    proxyState = newState;
    IPPProxyManager.dispatchEvent(new Event("IPPProxyManager:StateChanged"));
  };
  const load = () =>
    domainsSubmittedDuring(() =>
      stopRequest(telemetry, makeFinishedChannel("app.corp.example"))
    );

  Assert.deepEqual(load(), ["app.corp.example"], "First load is submitted");

  setState(IPPProxyStates.ACTIVE);
  Assert.deepEqual(load(), [], "A state event while active does not reset");

  for (const interruption of [
    IPPProxyStates.ERROR,
    IPPProxyStates.PAUSED,
    IPPProxyStates.READY,
  ]) {
    setState(interruption);
    setState(IPPProxyStates.ACTIVE);
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

    proxyState = IPPProxyStates.READY;
    proxyActive = false;
    connectionIsolationKey = null;
    IPPProxyManager.dispatchEvent(new Event("IPPProxyManager:StateChanged"));
    proxyState = IPPProxyStates.ACTIVE;
    proxyActive = true;
    connectionIsolationKey = "reconnected-key";
    IPPProxyManager.dispatchEvent(new Event("IPPProxyManager:StateChanged"));

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
