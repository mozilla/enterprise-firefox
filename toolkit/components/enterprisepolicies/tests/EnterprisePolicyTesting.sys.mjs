/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "resource://gre/modules/Preferences.sys.mjs";

import { Assert } from "resource://testing-common/Assert.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FileTestUtils: "resource://testing-common/FileTestUtils.sys.mjs",
  modifySchemaForTests: "resource:///modules/policies/schema.sys.mjs",
  sinon: "resource://testing-common/Sinon.sys.mjs",
  ConsoleClient: "resource:///modules/enterprise/ConsoleClient.sys.mjs",
});

export const EnterprisePolicyTesting = {
  /* The stub wrapping ConsoleClient.getRemotePolicies to control which remote policies are fetched */
  get remotePoliciesStub() {
    return this._remotePoliciesStub;
  },

  set remotePoliciesStub(stub) {
    this._remotePoliciesStub = stub;
  },

  /**
   * Observe for all policies to be applied. This notification
   * is sent when the policy engine is started up or reseted.
   *
   * @param {Promise} resolve Promise that resolves once all policies are applied.
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
   * Observe for a policy update. This notification is sent once
   * we check the console for updated policies.
   *
   * @param {Promise} resolve Promise that resolves once the policy update is handled.
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

  // |json| must be an object representing the desired policy configuration, OR a
  // path to the JSON file containing the policy configuration.
  setupPolicyEngineWithJson: async function setupPolicyEngineWithJson(
    json,
    customSchema
  ) {
    let filePath;
    if (typeof json == "object") {
      filePath = lazy.FileTestUtils.getTempFile("policies.json").path;

      // This file gets automatically deleted by FileTestUtils
      // at the end of the test run.
      await IOUtils.writeJSON(filePath, json);
    } else {
      filePath = json;
    }

    Services.prefs.setStringPref("browser.policies.alternatePath", filePath);

    const { promise, resolve } = Promise.withResolvers();
    this.resolveOnceAllPoliciesApplied(resolve);

    // Clear any previously used custom schema or assign a new one
    lazy.modifySchemaForTests(customSchema || null);

    Services.obs.notifyObservers(null, "EnterprisePolicies:Restart");
    return promise;
  },

  awaitNextPolicyUpdate() {
    const { promise, resolve } = Promise.withResolvers();
    this.resolveOnceAllPolicyUpdatesApplied(resolve);
    return promise;
  },

  /**
   * Apply the custom schema, setup the remote policies stub and
   * trigger a restart of the policy engine.
   *
   * @param {object} policies
   * @param {object} customSchema
   * @returns {Promise} Promise that resolves once the set of policies are applied
   */
  async servePolicyWithRemoteJson(policies, customSchema) {
    lazy.modifySchemaForTests(customSchema || null);

    const policiesAppliedPromise = this.applyRemotePolicies(policies, false);

    Services.obs.notifyObservers(null, "EnterprisePolicies:Restart");

    return policiesAppliedPromise;
  },

  /**
   * Listen for the policies to be applied and stub the remote policies.
   *
   * @param {object} policies
   * @param {boolean} isUpdate Whether the promise resolves once all policies are
   *                           applied on startup or once the policy update is complete
   * @returns {Promise} Promise that resolves once the set of policies are applied
   */
  async applyRemotePolicies(policies, isUpdate = true) {
    const { promise, resolve } = Promise.withResolvers();
    if (isUpdate) {
      // Resolve once policies are updated
      this.resolveOnceAllPolicyUpdatesApplied(resolve);
    } else {
      // Resolve once all policies are applied on initial activation
      this.resolveOnceAllPoliciesApplied(resolve);
    }

    if (this.remotePoliciesStub) {
      this.remotePoliciesStub.restore();
    }
    this.remotePoliciesStub = lazy.sinon.stub(
      lazy.ConsoleClient,
      "getRemotePolicies"
    );

    const returnRemotePolicies = () => {
      return Promise.resolve(policies);
    };

    this.remotePoliciesStub.callsFake(returnRemotePolicies);

    return promise;
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
      "resource:///modules/policies/Policies.sys.mjs"
    );
    this._originalFunc = PoliciesUtils.setDefaultPref.bind(PoliciesUtils);
    PoliciesUtils.setDefaultPref = this.hoistedSetDefaultPref.bind(this);
  },

  stop() {
    this.restoreDefaultValues();

    let { PoliciesUtils } = ChromeUtils.importESModule(
      "resource:///modules/policies/Policies.sys.mjs"
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

      if (defaults.has(prefName)) {
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
      // If a pref was used through setDefaultPref instead
      // of setAndLockPref, it wasn't locked, but calling
      // unlockPref is harmless
      if (Services.prefs.prefIsLocked(prefName)) {
        Preferences.unlock(prefName);
      }

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
