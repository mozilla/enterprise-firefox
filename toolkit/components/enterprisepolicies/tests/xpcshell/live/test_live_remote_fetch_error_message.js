/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Regression test for Bug 2062192. On an XHR error, ConsoleClient throws a
// TypeError whose message is a fixed marker, with the host and the channel
// status in its cause. about:policies lists the first argument of each logged
// error only, so that argument must name the host and the nsresult instead of
// the marker, both when a poll fails and when the startup fetch fails.

const { ConsoleClient } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/ConsoleClient.sys.mjs"
);
const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const ConsoleAPIStorage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(
  Ci.nsIConsoleAPIStorage
);

const CONSOLE_HOST = "console.example.com:8443";

const policiesSvc = Services.policies;
const policiesObs = policiesSvc.QueryInterface(Ci.nsIObserver);

function xhrError() {
  return new TypeError("ConsoleClientXHRError", {
    cause: {
      hostname: CONSOLE_HOST,
      channelStatus: Cr.NS_ERROR_CONNECTION_REFUSED,
    },
  });
}

// Collects the first argument of every error the policy engine logs, which is
// what about:policies displays, until stop() is called.
function collectPolicyErrors() {
  const messages = [];
  const listener = event => {
    if (event.prefix == "Enterprise Policies" && event.level == "error") {
      messages.push(event.arguments[0]);
    }
  };
  ConsoleAPIStorage.addLogEventListener(
    listener,
    Services.scriptSecurityManager.getSystemPrincipal()
  );
  return {
    messages,
    stop() {
      ConsoleAPIStorage.removeLogEventListener(listener);
    },
  };
}

function assertNamesHostAndStatus(message, host) {
  Assert.ok(
    message.includes(host),
    `The logged message names the console host: ${message}`
  );
  Assert.ok(
    /NS_ERROR_[A-Z_]+/.test(message),
    `The logged message names the channel status: ${message}`
  );
  Assert.ok(
    !message.includes("ConsoleClientXHRError"),
    `The logged message does not show the marker: ${message}`
  );
}

// Runs fn as a Felt browser and returns whether the engine signed out.
function withFakeFelt(fn) {
  const realFelt = Services.felt;
  let signedOut = false;
  Object.defineProperty(Services, "felt", {
    configurable: true,
    value: {
      isFeltBrowser: () => true,
      performSignout() {
        signedOut = true;
      },
    },
  });
  try {
    fn();
  } finally {
    Object.defineProperty(Services, "felt", {
      configurable: true,
      value: realFelt,
    });
  }
  return signedOut;
}

add_task(async function test_polling_error_without_cause_shows_its_text() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const errors = collectPolicyErrors();
  EnterprisePolicyTesting.remotePoliciesStub.callsFake(() =>
    Promise.reject(new TypeError("NS_ERROR_NET_TIMEOUT"))
  );
  await TestUtils.waitForCondition(
    () => errors.messages.length,
    "Waiting for the failed poll to be logged"
  );
  errors.stop();
  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });

  Assert.ok(
    errors.messages[0].includes("NS_ERROR_NET_TIMEOUT"),
    `An error without a cause is logged with its own text: ${errors.messages[0]}`
  );
});

add_task(async function test_polling_error_names_host_and_status() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  // Nothing listens on the port once the server stops, so the real request
  // made by ConsoleClient fails to connect.
  const server = new HttpServer();
  server.start(-1);
  const host = `127.0.0.1:${server.identity.primaryPort}`;
  await new Promise(resolve => server.stop(resolve));

  const errors = collectPolicyErrors();
  Services.prefs.setStringPref("enterprise.console.address", `http://${host}`);
  const tokenStub = sinon
    .stub(ConsoleClient, "getAccessToken")
    .resolves("test-token");
  EnterprisePolicyTesting.remotePoliciesStub.restore();
  EnterprisePolicyTesting.remotePoliciesStub = null;
  try {
    // Windows can take a few seconds to refuse a local connection.
    await TestUtils.waitForCondition(
      () => errors.messages.length,
      "Waiting for the failed poll to be logged",
      100,
      300
    );
  } finally {
    errors.stop();
    EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });
    tokenStub.restore();
    Services.prefs.setStringPref(
      "enterprise.console.address",
      "https://console.example.com"
    );
  }

  assertNamesHostAndStatus(errors.messages[0], host);
});

add_task(async function test_startup_error_names_host_and_fails_closed() {
  EnterprisePolicyTesting.remotePoliciesStub.callsFake(() =>
    Promise.reject(xhrError())
  );

  // policies-startup spins the event loop until initialization completes, so
  // every startup error has been logged once observe() returns.
  const errors = collectPolicyErrors();
  const signedOut = withFakeFelt(() => {
    Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
    policiesObs.observe(null, "policies-startup", null);
  });
  errors.stop();

  Assert.equal(
    policiesSvc.status,
    Ci.nsIEnterprisePolicies.FAILED,
    "The engine is FAILED after the startup fetch failed"
  );
  Assert.ok(signedOut, "A failed startup fetch fails closed by signing out");
  const message = errors.messages.find(m =>
    m.startsWith("Failed to fetch remote policies on startup")
  );
  Assert.ok(
    message,
    `The failed startup fetch is logged: ${errors.messages.join(" | ")}`
  );
  assertNamesHostAndStatus(message ?? "", CONSOLE_HOST);

  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });
});
