/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "resource://gre/modules/Preferences.sys.mjs";

import { Assert } from "resource://testing-common/Assert.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
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
  },

  stop() {
    this.restoreDefaultValues();

    let { PoliciesUtils } = ChromeUtils.importESModule(
      "resource://gre/modules/PoliciesHelpers.sys.mjs"
    );
    PoliciesUtils.setDefaultPref = this._originalFunc;
    this._originalFunc = null;
  },

  hoistedSetDefaultPref(prefName, prefValue, locked = false) {
    // If this pref is seen multiple times, the very first
    // value seen is the one that is actually the default.
    if (!this._originalValues.has(prefName)) {
      let defaults = new Preferences({ defaultBranch: true });
      let stored = {};

      if (
        Services.prefs.getDefaultBranch("").getPrefType(prefName) !=
        Ci.nsIPrefBranch.PREF_INVALID
      ) {
        stored.originalDefaultValue = defaults.get(prefName);
      } else {
        stored.originalDefaultValue = undefined;
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
