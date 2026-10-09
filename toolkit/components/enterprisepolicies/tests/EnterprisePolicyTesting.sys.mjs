/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "resource://gre/modules/Preferences.sys.mjs";

import { Assert } from "resource://testing-common/Assert.sys.mjs";

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserTestUtils: "resource://testing-common/BrowserTestUtils.sys.mjs",
  FileTestUtils: "resource://testing-common/FileTestUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  SearchTestUtils: "resource://testing-common/SearchTestUtils.sys.mjs",
  modifySchemaForTests: "resource:///modules/policies/schema.sys.mjs",
  sinon: "resource://testing-common/Sinon.sys.mjs",
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
});

export var EnterprisePolicyTesting = {
  // Path resolver for relative filenames. Must be set by each test head.
  // Mochitest heads use |getTestFilePath|; xpcshell heads use
  // |path => do_get_file(path).path|.
  pathResolver: null,

  /* The stub wrapping ConsoleClient.getRemotePolicies to control which remote policies are fetched */
  get remotePoliciesStub() {
    return this._remotePoliciesStub;
  },

  set remotePoliciesStub(stub) {
    this._remotePoliciesStub = stub;
  },

  /**
   * Listens for all policies to be applied. This notification
   * is sent when the policy engine is started up or reset.
   *
   * @param {Function} resolve a promise's resolve callback invoked once all policies are applied.
   */
  resolveOnceAllPoliciesApplied(resolve) {
    Services.obs.addObserver(function observer() {
      Services.obs.removeObserver(
        observer,
        "EnterprisePolicies:AllPoliciesApplied"
      );
      resolve();
    }, "EnterprisePolicies:AllPoliciesApplied");
  },

  /**
   * Listens for a policy update. This notification is sent once
   * we check the console for updated policies.
   *
   * @param {Function} resolve a promise's resolve callback invoked once all policy updates are applied.
   */
  resolveOnceAllPolicyUpdatesApplied(resolve) {
    Services.obs.addObserver(function observer() {
      Services.obs.removeObserver(
        observer,
        "EnterprisePolicies:PolicyUpdatesApplied"
      );
      resolve();
    }, "EnterprisePolicies:PolicyUpdatesApplied");
  },

  // |json| must be an object representing the desired policy configuration, OR
  // a path (absolute or test-relative) to the JSON file containing the policy
  // configuration. An empty string is treated as a non-existent file, which
  // disables the policy engine.
  setupPolicyEngineWithJson: async function setupPolicyEngineWithJson(
    json,
    customSchema
  ) {
    PoliciesPrefTracker.restoreDefaultValues();

    let filePath;
    if (typeof json == "object") {
      filePath = lazy.FileTestUtils.getTempFile("policies.json").path;

      // This file gets automatically deleted by FileTestUtils
      // at the end of the test run.
      await IOUtils.writeJSON(filePath, json);
    } else if (!json) {
      filePath = PathUtils.join(
        PathUtils.tempDir,
        "non-existing-policy-file.json"
      );
    } else if (PathUtils.isAbsolute(json)) {
      filePath = json;
    } else {
      filePath = EnterprisePolicyTesting.pathResolver(json);
    }

    Services.prefs.setStringPref("browser.policies.alternatePath", filePath);

    const { promise, resolve } = Promise.withResolvers();
    // Referenced by name rather than |this| because callers (e.g. the browser
    // test head) destructure setupPolicyEngineWithJson and call it unbound.
    EnterprisePolicyTesting.resolveOnceAllPoliciesApplied(resolve);

    // Clear any previously used custom schema or assign a new one
    lazy.modifySchemaForTests(customSchema || null);

    Services.obs.notifyObservers(null, "EnterprisePolicies:Restart");
    return promise;
  },

  // Loads a new enterprise policy and re-initialises the search service with
  // the new policy. Also waits for the search service to write the settings
  // file to disk.
  async setupPolicyEngineWithJsonForSearch(json, customSchema) {
    lazy.SearchService.reset();
    await EnterprisePolicyTesting.setupPolicyEngineWithJson(json, customSchema);
    let settingsWritten = lazy.SearchTestUtils.promiseSearchNotification(
      "write-settings-to-disk-complete"
    );
    await lazy.SearchService.init();
    await settingsWritten;
  },

  awaitNextPolicyUpdate() {
    const { promise, resolve } = Promise.withResolvers();
    this.resolveOnceAllPolicyUpdatesApplied(resolve);
    return promise;
  },

  awaitAllPoliciesApplied() {
    const { promise, resolve } = Promise.withResolvers();
    this.resolveOnceAllPoliciesApplied(resolve);
    return promise;
  },

  /**
   * Sets up policy engine with initial set of startup policies provided remotely
   *
   * @param {object} policies set of remote policies served by the stubbed ConsoleClient.getRemotePolicies
   * @param {object} customSchema custom policy schema
   * @returns {Promise} Promise that resolves once the initial set of policies are applied
   */
  async setupEngineWithRemotePolicies(policies, customSchema) {
    PoliciesPrefTracker.restoreDefaultValues();

    lazy.modifySchemaForTests(customSchema || null);

    const policiesAppliedPromise = this.awaitAllPoliciesApplied();

    this.stubRemotePolicies(policies);

    Services.obs.notifyObservers(null, "EnterprisePolicies:Restart");

    return policiesAppliedPromise;
  },

  /**
   * Stub ConsoleClient.getRemotePolicies so the remote provider serves the
   * given policies.
   *
   * @param {object} policies set of remote policies to serve
   */
  stubRemotePolicies(policies) {
    if (this.remotePoliciesStub) {
      this.remotePoliciesStub.restore();
    }
    this.remotePoliciesStub = lazy.sinon.stub(
      lazy.ConsoleClient,
      "getRemotePolicies"
    );
    this.remotePoliciesStub.callsFake(() => Promise.resolve(policies));
  },

  /**
   * Set up a policy engine that combines local policies (read from a local
   * policies.json) and remote policies (fetched from the stubbed ConsoleClient
   * endpoint).
   *
   * @param {object} localPolicies Policies to be read from a local policies.json
   * @param {object} remotePolicies Policies to be fetched from the stubbed endpoint
   * @param {object} customSchema
   * @returns {Promise} Resolves once local and remote policies are applied after a restart.
   */
  async setupPolicyEngineWithCombinedPolicyProvider(
    localPolicies,
    remotePolicies,
    customSchema
  ) {
    // Stub the remote policies endpoint before the restart so the remote provider
    // serves them during startup.
    EnterprisePolicyTesting.stubRemotePolicies(remotePolicies);

    // Apply the local policies (via policies.json) and restart the engine.
    return EnterprisePolicyTesting.setupPolicyEngineWithJson(
      localPolicies,
      customSchema
    );
  },

  checkPolicyPref(prefName, expectedValue, expectedLockedness) {
    if (expectedLockedness !== undefined) {
      Assert.equal(
        Preferences.locked(prefName),
        expectedLockedness,
        `Pref ${prefName} is correctly locked/unlocked`
      );
    }

    Assert.equal(
      Preferences.get(prefName),
      expectedValue,
      `Pref ${prefName} has the correct value`
    );
  },

  /**
   * Load a URL in a new tab of the most recent browser window and assert
   * whether the policy engine blocked it, i.e. replaced the page with
   * about:neterror?e=blockedByPolicy. Browser-chrome only.
   *
   * @param {string} url page to load
   * @param {boolean} expectedBlocked whether the load is expected to be blocked
   * @returns {Promise<void>} resolves once the assertion has been made
   */
  async checkBlockedPage(url, expectedBlocked) {
    let gBrowser =
      Services.wm.getMostRecentWindow("navigator:browser").gBrowser;
    let newTab = lazy.BrowserTestUtils.addTab(gBrowser);
    gBrowser.selectedTab = newTab;

    if (expectedBlocked) {
      let promise = lazy.BrowserTestUtils.waitForErrorPage(
        gBrowser.selectedBrowser
      );
      lazy.BrowserTestUtils.startLoadingURIString(gBrowser, url);
      await promise;

      const errorPage = AppConstants.MOZ_ENTERPRISE
        ? "blockedByPolicyEnterprise"
        : "blockedByPolicy";
      Assert.ok(
        newTab.linkedBrowser.documentURI.spec.startsWith(
          `about:neterror?e=${errorPage}`
        ),
        "Should be blocked by policy"
      );
    } else {
      let promise = lazy.BrowserTestUtils.browserStopped(gBrowser, url);
      lazy.BrowserTestUtils.startLoadingURIString(gBrowser, url);
      await promise;
      Assert.equal(
        newTab.linkedBrowser.documentURI.spec,
        url,
        "Should not be blocked by policy"
      );
    }
    lazy.BrowserTestUtils.removeTab(newTab);
  },

  resetRunOnceState: function resetRunOnceState() {
    const runOnceBaseKeys = [
      "browser.policies.runonce.",
      "browser.policies.runOncePerModification.",
    ];
    for (let base of runOnceBaseKeys) {
      for (let key of Services.prefs.getChildList(base)) {
        if (Services.prefs.prefHasUserValue(key)) {
          Services.prefs.clearUserPref(key);
        }
      }
    }
  },
};

/**
 * This helper will track prefs that have been changed
 * by the policy engine through the setAndLockPref and
 * setDefaultPref APIs (from Policies.sys.mjs) and make sure
 * that they are restored to their original values when
 * the test ends or another test case restarts the engine.
 */
export var PoliciesPrefTracker = {
  _originalFunc: null,
  _originalValues: new Map(),

  start() {
    let { PoliciesUtils } = ChromeUtils.importESModule(
      "resource://gre/modules/PoliciesHelpers.sys.mjs"
    );
    this._originalFunc = PoliciesUtils.setDefaultPref.bind(PoliciesUtils);
    PoliciesUtils.setDefaultPref = this.hoistedSetDefaultPref.bind(this);

    // Web serial support is automatically disabled by default by enterprise policies, we want to
    // reset that state at the end of the test to avoid the harness complaining about a changed
    // preference.
    this._webSerialState = Services.prefs
      .getDefaultBranch("")
      .getBoolPref("dom.webserial.enabled", true);
  },

  stop() {
    this.restoreDefaultValues();

    let { PoliciesUtils } = ChromeUtils.importESModule(
      "resource://gre/modules/PoliciesHelpers.sys.mjs"
    );
    PoliciesUtils.setDefaultPref = this._originalFunc;
    this._originalFunc = null;

    Services.prefs
      .getDefaultBranch("")
      .setBoolPref("dom.webserial.enabled", this._webSerialState);
  },

  hoistedSetDefaultPref(prefName, prefValue, locked = false) {
    // If this pref is seen multiple times, the very first
    // value seen is the one that is actually the default.
    if (!this._originalValues.has(prefName)) {
      let defaults = new Preferences({ defaultBranch: true });
      let stored = {};

      if (Services.prefs.prefHasDefaultValue(prefName)) {
        stored.originalDefaultValue = defaults.get(prefName);
      } else {
        stored.originalDefaultValue = undefined;
        // Restoring a pref without a default deletes it outright, which would
        // take a pre-existing user value with it.
        if (Services.prefs.prefHasUserValue(prefName)) {
          stored.originalUserValue = Preferences.get(prefName);
        }
      }

      if (
        Preferences.isSet(prefName) &&
        Preferences.get(prefName) == prefValue
      ) {
        // If a user value exists, and we're changing the default
        // value to be th same as the user value, that will cause
        // the user value to be dropped. In that case, let's also
        // store it to ensure that we restore everything correctly.
        stored.originalUserValue = Preferences.get(prefName);
      }

      this._originalValues.set(prefName, stored);
    }

    // Now that we've stored the original values, call the
    // original setDefaultPref function.
    this._originalFunc(prefName, prefValue, locked);
  },

  restoreDefaultValues() {
    let defaults = new Preferences({ defaultBranch: true });

    for (let [prefName, stored] of this._originalValues) {
      if (Preferences.get(prefName) === undefined) {
        // Pref might have been removed by the test.
        continue;
      }
      // If a pref was used through setDefaultPref instead
      // of setAndLockPref, it wasn't locked, but calling
      // unlockPref is harmless
      Services.prefs.unlockPref(prefName);

      if (stored.originalDefaultValue !== undefined) {
        defaults.set(prefName, stored.originalDefaultValue);
      } else {
        Services.prefs.getDefaultBranch("").deleteBranch(prefName);
      }

      if (stored.originalUserValue !== undefined) {
        Preferences.set(prefName, stored.originalUserValue);
      }
    }

    this._originalValues.clear();
  },
};

/**
 * Collects, for one event metric, the events the enterprise ping carries each
 * time it is submitted.
 *
 * Every enterprise security event submits the ping right after it is recorded,
 * which clears the recorded events, so a test can only read them from inside
 * the submit hook. testBeforeNextSubmit is a one-shot hook that the collector
 * re-arms after every submit until it is stopped or disposed. The ping holds a
 * single hook, so only one collector can be live at a time: constructing a
 * second one throws, and stop() only touches the hook while this collector owns
 * it. Nothing else may register a hook on the enterprise ping while a collector
 * is live; the collector cannot detect a hook that was taken over.
 */
export class EnterprisePingCollector {
  static #owner = null;
  #metric;
  #pings = [];
  #error = null;

  /**
   * @param {object} metric
   *        The Glean event metric to read from each submitted ping, e.g.
   *        Glean.safebrowsing.siteVisit.
   */
  constructor(metric) {
    if (
      typeof metric?.record != "function" ||
      typeof metric?.testGetValue != "function"
    ) {
      throw new TypeError(
        "metric must be a Glean event metric such as Glean.safebrowsing.siteVisit"
      );
    }
    if (EnterprisePingCollector.#owner) {
      throw new Error(
        "Another EnterprisePingCollector is still live; stop() it first"
      );
    }
    this.#metric = metric;
    this.#arm();
    EnterprisePingCollector.#owner = this;
  }

  #arm() {
    GleanPings.enterprise.testBeforeNextSubmit(() => {
      // Re-arm before reading so collection continues whatever the read does.
      this.#arm();
      try {
        this.#pings.push(this.#metric.testGetValue("enterprise") ?? []);
      } catch (e) {
        this.#error ??= e;
        this.#pings.push([]);
      }
    });
  }

  // The hook runs inside the recorder's submit() call, where a throw is
  // swallowed by the recorder, discarded by FOG for the C++ recorders, or
  // escapes into the recorder's caller rather than failing the test, so a read
  // that failed there is reported from the getters instead.
  #rethrow() {
    if (this.#error) {
      throw this.#error;
    }
  }

  /**
   * The metric's events carried by every ping submitted so far, in submission
   * order.
   *
   * @returns {object[]}
   */
  get events() {
    this.#rethrow();
    return this.#pings.flat();
  }

  /**
   * How many times submit() has been called on the enterprise ping so far,
   * whichever metric triggered it.
   *
   * @returns {number}
   */
  get submitCount() {
    this.#rethrow();
    return this.#pings.length;
  }

  /**
   * Asserts that the metric recorded nothing: no enterprise ping was submitted
   * and, since a submit would have cleared them, no events are waiting in the
   * store either.
   *
   * @param {string} message
   *        Why nothing should have been recorded.
   */
  assertNothingRecorded(message) {
    Assert.equal(
      this.submitCount,
      0,
      `${message}: no enterprise ping was submitted`
    );
    Assert.ok(
      !this.#metric.testGetValue("enterprise")?.length,
      `${message}: no event is waiting in the store`
    );
  }

  /**
   * Stops collecting and replaces the pending one-shot hook with a no-op so it
   * does not fire during a later test. Calling it again does nothing.
   */
  stop() {
    if (EnterprisePingCollector.#owner !== this) {
      return;
    }
    EnterprisePingCollector.#owner = null;
    GleanPings.enterprise.testBeforeNextSubmit(() => {});
  }

  [Symbol.dispose]() {
    this.stop();
  }
}
