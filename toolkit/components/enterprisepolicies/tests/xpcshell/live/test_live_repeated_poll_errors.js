/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Regression test for Bug 2074889. about:policies lists every error the policy
// engine logs, so a failure that repeats on every poll must be logged once
// rather than once per poll, and a failed startup fetch must be logged once
// rather than twice.

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const ConsoleAPIStorage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(
  Ci.nsIConsoleAPIStorage
);

const CONSOLE_HOST = "console.example.com:8443";

const policiesObs = Services.policies.QueryInterface(Ci.nsIObserver);

function xhrError(channelStatus) {
  return new TypeError("ConsoleClientXHRError", {
    cause: { hostname: CONSOLE_HOST, channelStatus },
  });
}

// Collects the first argument of every error the policy engine logs, which is
// what about:policies displays, until stop() is called.
function collectPolicyErrors() {
  const messages = [];
  const listener = event => {
    if (event.prefix == "Enterprise Policies" && event.level == "error") {
      messages.push(String(event.arguments[0]));
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

// Answers polls with fake until the console has been polled a few more times.
async function pollRepeatedly(fake) {
  const stub = EnterprisePolicyTesting.remotePoliciesStub;
  stub.callsFake(fake);
  const target = stub.callCount + 3;
  await TestUtils.waitForCondition(
    () => stub.callCount >= target,
    "Waiting for the console to be polled"
  );
}

add_task(async function test_each_distinct_poll_failure_is_logged_once() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const errors = collectPolicyErrors();
  await pollRepeatedly(() =>
    Promise.reject(xhrError(Cr.NS_ERROR_CONNECTION_REFUSED))
  );
  await pollRepeatedly(() =>
    Promise.reject(xhrError(Cr.NS_ERROR_UNKNOWN_HOST))
  );
  errors.stop();
  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });

  Assert.equal(
    errors.messages.length,
    2,
    `Each distinct poll failure is logged once: ${errors.messages.join(" | ")}`
  );
  Assert.ok(
    errors.messages[0].includes("NS_ERROR_CONNECTION_REFUSED"),
    `The first failure is logged first: ${errors.messages[0]}`
  );
  Assert.ok(
    errors.messages[1].includes("NS_ERROR_UNKNOWN_HOST"),
    `The second failure is logged when it differs: ${errors.messages[1]}`
  );
});

add_task(async function test_poll_failure_is_logged_again_after_recovery() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const failure = () =>
    Promise.reject(xhrError(Cr.NS_ERROR_CONNECTION_REFUSED));
  const errors = collectPolicyErrors();
  await pollRepeatedly(failure);
  await pollRepeatedly(() => Promise.resolve({ policies: {} }));
  await pollRepeatedly(failure);
  errors.stop();
  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });

  Assert.equal(
    errors.messages.length,
    2,
    `A failure is logged again after a successful poll: ${errors.messages.join(" | ")}`
  );
});

add_task(async function test_repeated_missing_policies_are_logged_once() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const errors = collectPolicyErrors();
  await pollRepeatedly(() => Promise.resolve({}));
  errors.stop();
  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });

  const missing = errors.messages.filter(m =>
    m.startsWith("No policies were found in the response")
  );
  Assert.equal(
    missing.length,
    1,
    `A response without policies is logged once: ${errors.messages.join(" | ")}`
  );
});

add_task(async function test_failed_startup_fetch_is_logged_once() {
  EnterprisePolicyTesting.remotePoliciesStub.callsFake(() =>
    Promise.reject(xhrError(Cr.NS_ERROR_CONNECTION_REFUSED))
  );

  // policies-startup spins the event loop until initialization completes, so
  // every startup error has been logged once observe() returns.
  const errors = collectPolicyErrors();
  Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
  policiesObs.observe(null, "policies-startup", null);
  errors.stop();
  EnterprisePolicyTesting.stubRemotePolicies({ policies: {} });

  Assert.equal(
    errors.messages.length,
    1,
    `A failed startup fetch is logged once: ${errors.messages.join(" | ")}`
  );
  Assert.ok(
    errors.messages[0]?.includes(CONSOLE_HOST),
    `The logged line is the one that names the console host: ${errors.messages[0]}`
  );
});
