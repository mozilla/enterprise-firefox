/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CanonicalJSON: "resource://gre/modules/CanonicalJSON.sys.mjs",
  EnterpriseHandler:
    "resource://gre/modules/enterprise/EnterpriseHandler.sys.mjs",
  // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
  Policies: "resource:///modules/policies/Policies.sys.mjs",
  PolicySchemaValidator:
    "resource://gre/modules/policies/PolicySchemaValidator.sys.mjs",
  WindowsGPOParser: "resource://gre/modules/policies/WindowsGPOParser.sys.mjs",
  macOSPoliciesParser:
    "resource://gre/modules/policies/macOSPoliciesParser.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  SitePolicyUtils: "resource://gre/modules/SitePolicyUtils.sys.mjs",
});

// This is the file that will be searched for in the
// ${InstallDir}/distribution folder.
const POLICIES_FILENAME = "policies.json";

// When true browser policy is loaded per-user from
// /run/user/$UID/appname
const PREF_PER_USER_DIR = "toolkit.policies.perUserDir";
// For easy testing, modify the helpers/sample.json file,
// and set PREF_ALTERNATE_PATH in firefox.js as:
// /your/repo/browser/components/enterprisepolicies/helpers/sample.json
const PREF_ALTERNATE_PATH = "browser.policies.alternatePath";
// For testing GPO, you can set an alternate location in testing
const PREF_ALTERNATE_GPO = "browser.policies.alternateGPO";

// For testing, we may want to set PREF_ALTERNATE_PATH to point to a file
// relative to the test root directory. In order to enable this, the string
// below may be placed at the beginning of that preference value and it will
// be replaced with the path to the test root directory.
const MAGIC_TEST_ROOT_PREFIX = "<test-root>";
const PREF_TEST_ROOT = "mochitest.testRoot";

const PREF_LOGLEVEL = "browser.policies.loglevel";

// To allow for cleaning up old policies
const PREF_POLICIES_APPLIED = "browser.policies.applied";

const PREF_REMOTE_POLICIES_ENABLED = "enterprise.policies.live.enabled";

const POLICY_DISABLE_LOCAL_POLICIES = "DisableLocalPolicies";

const STATUS_NAMES = {
  [Ci.nsIEnterprisePolicies.UNINITIALIZED]: "UNINITIALIZED",
  [Ci.nsIEnterprisePolicies.INACTIVE]: "INACTIVE",
  [Ci.nsIEnterprisePolicies.ACTIVE]: "ACTIVE",
  [Ci.nsIEnterprisePolicies.FAILED]: "FAILED",
};

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  let { ConsoleAPI } = ChromeUtils.importESModule(
    "resource://gre/modules/Console.sys.mjs"
  );
  return new ConsoleAPI({
    prefix: "Enterprise Policies",
    // tip: set maxLogLevel to "debug" and use log.debug() to create detailed
    // messages during development. See LOG_LEVELS in Console.sys.mjs for details.
    maxLogLevel: "error",
    maxLogLevelPref: PREF_LOGLEVEL,
  });
});

// Testing escapes in this file must key on Cu.isInAutomation.

// On Nightly in automation, ignore real system/user policies so a developer's
// local policies.json or registry entries don't leak into tests.
function shouldIgnoreLocalPolicies() {
  return AppConstants.NIGHTLY_BUILD && Cu.isInAutomation;
}

// We're only testing for empty objects, not
// empty strings or empty arrays.
function isEmptyObject(obj) {
  if (typeof obj != "object" || Array.isArray(obj)) {
    return false;
  }
  for (let key of Object.keys(obj)) {
    if (!isEmptyObject(obj[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Error thrown when the remote policies provider fails to fetch
 * the startup policies while building the combined provider.
 */
class RemotePolicyProviderInitError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RemotePolicyProviderInitError";
  }
}

/**
 * Compute a stable hash of a JSON-serialisable value. Used to detect whether a
 * policy set (or a single policy's parameters) changed without having to
 * re-parse and re-validate them.
 *
 * @param {object} value
 * @returns {string} base64-encoded SHA-256 digest
 */
function hashValue(value) {
  const bytes = new TextEncoder().encode(
    lazy.CanonicalJSON.stringify(value) ?? ""
  );
  const hasher = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hasher.init(Ci.nsICryptoHash.SHA256);
  hasher.update(bytes, bytes.length);
  return hasher.finish(true);
}

export function EnterprisePoliciesManager() {
  Services.obs.addObserver(this, "profile-after-change", true);
  Services.obs.addObserver(this, "final-ui-startup", true);
  Services.obs.addObserver(this, "sessionstore-windows-restored", true);
  Services.obs.addObserver(this, "EnterprisePolicies:Reset", true);
  Services.obs.addObserver(this, "EnterprisePolicies:Restart", true);
  Services.obs.addObserver(this, "EnterprisePolicies:Update", true);
  Services.obs.addObserver(this, "distribution-customization-complete", true);
}

EnterprisePoliciesManager.prototype = {
  QueryInterface: ChromeUtils.generateQI([
    "nsIObserver",
    "nsISupportsWeakReference",
    "nsIEnterprisePolicies",
  ]),

  // Single or combined provider
  _provider: null,

  // Caches latest set of parsed policies
  _parsedPolicies: {},

  // Per-policy hash of the raw parameters last applied,
  // used to skip re-parsing individual unchanged policies on an update.
  _lastParamsHashes: new Map(),

  _cleanupPolicies() {
    if (Services.prefs.getBoolPref(PREF_POLICIES_APPLIED, false)) {
      if ("_cleanup" in lazy.Policies) {
        let policyImpl = lazy.Policies._cleanup;
        this._schedulePolicyActivations("_cleanup", policyImpl);
      }
      Services.prefs.clearUserPref(PREF_POLICIES_APPLIED);
    }
  },

  /**
   * Remote polling is enabled always when we are in felt launched browser
   * or if the preference is set explicitly
   *
   * @returns {boolean} whether polling remote policies is enabled
   */
  _isRemotePoliciesSupported() {
    return (
      AppConstants.MOZ_ENTERPRISE &&
      (Services.felt.isFeltBrowser() ||
        Services.prefs.getBoolPref(PREF_REMOTE_POLICIES_ENABLED, false))
    );
  },

  async _initialize() {
    this._cleanupPolicies();

    Services.prefs.setBoolPref(PREF_POLICIES_APPLIED, false);

    try {
      this._provider = await this._buildProvider();
    } catch (e) {
      if (e instanceof RemotePolicyProviderInitError) {
        lazy.log.error(
          `Failed to fetch startup policies when building the policies provider: ${e}`
        );
        // bug 2027006 will move the fetching of policies to felt
        // and no shutdown will be needed then
        lazy.EnterpriseHandler.initiateShutdown();
      } else {
        lazy.log.error(`Failed to build the policies provider: ${e}`);
      }
      return;
    }

    this._updateStatus();

    if (this.status !== Ci.nsIEnterprisePolicies.ACTIVE) {
      return;
    }

    // Make Web Serial support be opt-in for enterprise policies.
    Services.prefs
      .getDefaultBranch("")
      .setBoolPref("dom.webserial.enabled", false);

    this._activateStartupPolicies();
  },

  _reportEnterpriseTelemetry() {
    Glean.policies.count.set(Object.keys(this._parsedPolicies || {}).length);
    Glean.policies.isEnterprise.set(this.isEnterprise);
  },

  /**
   * Build the policies provider. Every available source (JSON, platform, and
   * the remote source in enterprise builds) is added to a single
   * CombinedProvider, in increasing order of precedence.
   *
   * @returns {Promise<CombinedProvider>} the combined policies provider
   * @throws {RemotePolicyProviderInitError} when the startup policies couldn't
   *                 be fetched
   */
  async _buildProvider() {
    const provider = new CombinedProvider();

    // The remote provider is built first so we can perform an early lookup
    // whether the DisableLocalPolicies policy is present.
    let remoteProvider = null;
    if (this._isRemotePoliciesSupported()) {
      lazy.log.debug("Remote policies supported, fetching startup policies.");
      remoteProvider = RemotePoliciesProvider.getInstance();
      try {
        // Ingest the startup policies.
        await remoteProvider.ingestPolicies();
      } catch (e) {
        lazy.log.error(`Failed to fetch remote policies on startup: ${e}`);
        remoteProvider._failed = true;
        throw new RemotePolicyProviderInitError(
          "Failed to fetch remote policies on startup",
          { cause: e }
        );
      }
    } else {
      lazy.log.debug(
        "Remote policies not supported; skipping remote provider."
      );
    }

    if (!remoteProvider?.disablesLocalPolicies) {
      lazy.log.debug("Adding JSON provider.");
      provider.push(new JSONPoliciesProvider());

      if (AppConstants.MOZ_SYSTEM_POLICIES) {
        if (AppConstants.platform == "win") {
          lazy.log.debug("Adding Windows GPO platform provider.");
          provider.push(new WindowsGPOPoliciesProvider());
        } else if (AppConstants.platform == "macosx") {
          lazy.log.debug("Adding macOS platform provider.");
          provider.push(new macOSPoliciesProvider());
        }
      }
    } else {
      lazy.log.debug("Local policies disabled; skipping local providers.");
    }

    if (remoteProvider) {
      // The remote provider takes precedence over the local ones,
      // so it is added last.
      lazy.log.debug("Adding remote provider.");
      provider.push(remoteProvider);
    }

    provider.mergePolicies();
    return provider;
  },

  /**
   * Update engine status after parsing policies
   */
  _updateStatus() {
    if (this._provider.failed) {
      this.status = Ci.nsIEnterprisePolicies.FAILED;
    } else if (!isEmptyObject(this._effectivePolicies())) {
      this.status = Ci.nsIEnterprisePolicies.ACTIVE;
      Services.prefs.setBoolPref(PREF_POLICIES_APPLIED, true);
    } else {
      this.status = Ci.nsIEnterprisePolicies.INACTIVE;
    }
  },

  /**
   * The set of policies to apply both on initial activation
   * and remote updates.
   *
   * @returns {object} policies to apply
   */
  _effectivePolicies() {
    const policies = this._provider.policies || {};
    if (
      Object.keys(policies).length === 1 &&
      policies.Certificates &&
      Object.keys(policies.Certificates).length === 1 &&
      (policies.Certificates.ImportEnterpriseRoots === true ||
        policies.Certificates.ImportEnterpriseRoots === 1)
    ) {
      // The ImportEnterpriseRoots certificate
      // policy is ignored when it is the only policy present: it is already true
      // by default, so this prevents e.g. antivirus software from activating the
      // policy engine merely by setting it.
      return {};
    }
    return policies;
  },

  /**
   * Activates the startup policies that are provided during
   * the initialization of the policy engine.
   */
  _activateStartupPolicies() {
    const effectivePolicies = this._effectivePolicies();

    lazy.log.debug(
      `Parsing ${Object.keys(effectivePolicies).length} startup policies.`
    );

    for (const [policyName, policyParams] of Object.entries(
      effectivePolicies
    )) {
      const { isValid, parsedParams } = this._validateAndParsePolicyParams(
        policyName,
        policyParams
      );

      if (!isValid) {
        lazy.log.warn(`Invalid policy parameters provided for ${policyName}.`);
        continue;
      }

      lazy.log.debug(`Parsed startup policy ${policyName}.`);
      this._parsedPolicies[policyName] = parsedParams;
      this._lastParamsHashes.set(policyName, hashValue(policyParams));

      const policyImpl = lazy.Policies[policyName];
      this._schedulePolicyActivations(policyName, policyImpl, parsedParams);
    }

    this._updateStatus();
  },

  /**
   * Parses, validates and applies any policy changes by comparing
   * the previously parsed set of policies with the updated set
   * from the remote provider.
   *
   * - Apply no changes to a policy if it remains unchanged.
   * - Re-apply a policy if the parameters changed.
   * - Remove a policy if it's missing in the updated set.
   */
  _updatePolicies() {
    if (!this._provider) {
      // The engine was probably reset while a polling request was
      // in flight. There is nothing to update.
      return;
    }

    this._provider.mergePolicies();

    lazy.log.debug(
      `Applying policy update with ${
        Object.keys(this._effectivePolicies()).length
      } effective policies.`
    );

    let previousPolicies = null;
    try {
      previousPolicies = structuredClone(this._parsedPolicies || {});
    } catch (ex) {
      // DataCloneError: URL object could not be cloned.
      if (ex.name === "DataCloneError") {
        previousPolicies = JSON.parse(JSON.stringify(this._parsedPolicies));
      } else {
        throw ex;
      }
    }

    this._schedulePolicyUpdates(previousPolicies);

    this._schedulePolicyRemovals(previousPolicies);

    // Run removals first so that an updated policy is torn down (with its
    // previous parameters) before it is re-applied with the new ones.
    this._runPoliciesCallbacks("onRemove");

    for (const timing of Object.keys(this._callbacks)) {
      if (timing === "onRemove") {
        continue;
      }
      const topic = this.topicByCallbackTiming[timing];
      if (!this._topicsObserved.has(topic)) {
        // Only run callbacks for a timing that
        // has already been observed.
        continue;
      }
      this._runPoliciesCallbacks(timing);
    }

    this._updateStatus();
  },

  /**
   * Parse and schedule a policy update. This also schedules removals for
   * changed policies so that updates are applied on a clean state.
   *
   * @param {object} previousPolicies the set of policies parsed and applied
   *   before this update
   */
  _schedulePolicyUpdates(previousPolicies) {
    const parsedPolicies = {};
    const paramsHashes = new Map();

    for (const [policyName, policyParams] of Object.entries(
      this._effectivePolicies()
    )) {
      const paramsHash = hashValue(policyParams);

      if (
        this._lastParamsHashes.get(policyName) === paramsHash &&
        policyName in previousPolicies
      ) {
        // Skip re-parsing a policy whose raw parameters are unchanged.
        // Instead reuse the previously parsed value and leave it applied.
        lazy.log.debug(`Policy ${policyName} unchanged.`);
        parsedPolicies[policyName] = previousPolicies[policyName];
        paramsHashes.set(policyName, paramsHash);
        continue;
      }

      lazy.log.debug(`Parsing updated policy ${policyName}.`);

      const { isValid, parsedParams } = this._validateAndParsePolicyParams(
        policyName,
        policyParams
      );

      if (!isValid) {
        lazy.log.debug(`Updated policy params for ${policyName} are invalid.`);
        if (policyName in previousPolicies) {
          // The updated policy params are invalid. Keep the previously applied policy version.
          parsedPolicies[policyName] = previousPolicies[policyName];
          paramsHashes.set(policyName, this._lastParamsHashes.get(policyName));
          lazy.log.debug(`Skipping policy update for ${policyName}.`);
        }
        continue;
      }

      parsedPolicies[policyName] = parsedParams;
      paramsHashes.set(policyName, paramsHash);

      if (policyName in previousPolicies) {
        // Parameters changed: remove the policy (with its previous
        // parameters) before re-applying it with the new ones.
        this._schedulePolicyRemoval(policyName, previousPolicies[policyName]);
      }

      const policyImpl = lazy.Policies[policyName];
      this._schedulePolicyActivations(policyName, policyImpl, parsedParams);
    }

    this._parsedPolicies = parsedPolicies;
    this._lastParamsHashes = paramsHashes;
  },

  /**
   * Schedule callbacks to remove policies that are no longer present in the
   * latest set of parsed policies.
   *
   * @param {object} previousPolicies the set of policies parsed and applied
   *   before this update
   */
  _schedulePolicyRemovals(previousPolicies) {
    for (const [policyName, policyParams] of Object.entries(previousPolicies)) {
      if (this._parsedPolicies[policyName] !== undefined) {
        // Policy remains active.
        continue;
      }

      lazy.log.debug(`Removing policy ${policyName} no longer present.`);
      this._schedulePolicyRemoval(policyName, policyParams);
    }
  },

  /**
   * Schedule the onRemove callback for a single policy.
   *
   * @param {string} policyName policy name
   * @param {object} params parameters the policy was last applied with
   */
  _schedulePolicyRemoval(policyName, params) {
    const policyImpl = lazy.Policies[policyName];
    if (!policyImpl) {
      // This means there is an entry in the schema, but no implementation.
      // We only do this when we deprecate policies.
      lazy.log.warn(`The policy ${policyName} has been deprecated.`);
      return;
    }

    if (!policyImpl.onRemove) {
      lazy.log.warn(`Policy ${policyName} does not support removal.`);
      return;
    }

    this._schedulePolicyCallback("onRemove", {
      policyName,
      callback: policyImpl.onRemove,
      impl: policyImpl,
      params,
    });
  },

  /**
   * Validate and parse the policy parameters
   *
   * @param {object} policyName policy name
   * @param {object} policyParams policy parameters
   * @returns {{ isValid: boolean, parsedParams: object|null}}
   */
  _validateAndParsePolicyParams(policyName, policyParams) {
    const { schema } = ChromeUtils.importESModule(
      // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
      "resource:///modules/policies/schema.sys.mjs"
    );
    const policySchema = schema.properties[policyName];

    if (!policySchema) {
      lazy.log.error(`Unknown policy: ${policyName}`);
      return { isValid: false, parsedParams: null };
    }

    const {
      valid: isValid,
      parsedValue: parsedParams,
      error: validationError,
    } = lazy.PolicySchemaValidator.validate(policyParams, policySchema, {
      allowAdditionalProperties: true,
    });

    if (!isValid) {
      lazy.log.error(
        `Invalid parameters specified for ${policyName}: ${validationError.message}`
      );
      return { isValid: false, parsedParams: null };
    }

    const policyImpl = lazy.Policies[policyName];
    if (!policyImpl) {
      // This means there is an entry in the schema, but no implementation.
      // We only do this when we deprecate policies.
      lazy.log.info(`${policyName} has been deprecated.`);
      return { isValid: false, parsedParams: null };
    }

    if (policyImpl.validate && !policyImpl.validate(parsedParams)) {
      lazy.log.error(
        `Parameters for ${policyName} did not validate successfully.`
      );
      return { isValid: false, parsedParams: null };
    }

    return { isValid, parsedParams };
  },

  /**
   * Policy implementation
   *
   * @typedef {object} PolicyImpl
   * @property {Function} [onBeforeAddons] - callback that is invoked when notified of a policies-startup event
   * @property {Function} [onProfileAfterChange] - callback that is invoked when notified of a profile-after-change event
   * @property {Function} [onBeforeUIStartup] - callback that is invoked when notified of a final-ui-startup event
   * @property {Function} [onAllWindowsRestored] - callback that is invoked when notified of a sessionstore-windows-restored event
   * @property {Function} [onRemove] - callback that is invoked when a policy is explicitly removed
   */

  /**
   * Schedule all "activating" callbacks, meaning any
   * "onRemove" callbacks are skipped
   *
   * @param {string} policyName policy name
   * @param {PolicyImpl} policyImpl policy implementation
   * @param {object} [parsedParams] parsed policy parameters
   */
  _schedulePolicyActivations(policyName, policyImpl, parsedParams = undefined) {
    for (let timing of Object.keys(this._callbacks)) {
      if (timing === "onRemove") {
        // Callbacks that remove policies are explicitly scheduled.
        continue;
      }

      let policyCallback = policyImpl[timing];
      if (policyCallback) {
        this._schedulePolicyCallback(timing, {
          policyName,
          callback: policyCallback,
          impl: policyImpl,
          params: parsedParams,
        });
      }
    }
  },

  _callbacks: {
    // The earliest that a policy callback can run. This will
    // happen right after the Policy Engine itself has started,
    // and before the Add-ons Manager has started.
    onBeforeAddons: [],

    // This happens after all the initialization related to
    // the profile has finished (prefs, places database, etc.).
    onProfileAfterChange: [],

    // Just before the first browser window gets created.
    onBeforeUIStartup: [],

    // Called after all windows from the last session have been
    // restored (or the default window and homepage tab, if the
    // session is not being restored).
    // The content of the tabs themselves have not necessarily
    // finished loading.
    onAllWindowsRestored: [],

    // Called when the policy gets removed
    onRemove: [],
  },

  /**
   * Schedule a single policy callback for a given timing, skipping it if the
   * same policy's callback with the same parameters is already scheduled.
   *
   * @param {string} timing callback timing, a key of `_callbacks`
   * @param {object} entry callback entry to schedule
   * @param {string} entry.policyName policy name
   * @param {Function} entry.callback the policy's callback for this timing
   * @param {PolicyImpl} entry.impl the policy implementation
   * @param {object} [entry.params] parsed policy parameters
   */
  _schedulePolicyCallback(timing, entry) {
    // For a given timing, a policy name uniquely identifies its callback, so
    // an entry is a duplicate when both the policy name and the parameters
    // match. Parameters may differ at the object level, so compare them with
    // JSON.stringify().
    const alreadyScheduled = this._callbacks[timing].some(
      e =>
        e.policyName === entry.policyName &&
        JSON.stringify(e.params) === JSON.stringify(entry.params)
    );
    if (alreadyScheduled) {
      lazy.log.debug(
        `A ${timing} callback for policy ${entry.policyName} was already scheduled.`
      );
      return;
    }
    lazy.log.debug(
      `Scheduling a ${timing} callback for policy ${entry.policyName}.`
    );
    this._callbacks[timing].push(entry);
  },

  _runPoliciesCallbacks(timing) {
    let callbacks = this._callbacks[timing];
    while (callbacks.length) {
      let { callback, impl, params } = callbacks.shift();
      const boundCallback = callback.bind(impl, this, params);
      try {
        boundCallback();
      } catch (ex) {
        lazy.log.error("Error running ", boundCallback, `for ${timing}:`, ex);
      }
    }
  },

  async _resetEngine() {
    lazy.log.debug("Resetting policy engine.");
    DisallowedFeatures = {};
    SitePolicies = [];

    Services.ppmm.sharedData.delete("EnterprisePolicies:Status");
    Services.ppmm.sharedData.delete("EnterprisePolicies:DisallowedFeatures");
    Services.ppmm.sharedData.delete("EnterprisePolicies:SitePolicies");

    this.status = Ci.nsIEnterprisePolicies.UNINITIALIZED;
    this._parsedPolicies = {};
    this._lastParamsHashes = new Map();
    if (this._isRemotePoliciesSupported()) {
      RemotePoliciesProvider.dropInstance();
    }
    this._provider = null;
    this._topicsObserved = new Set();
    for (let timing of Object.keys(this._callbacks)) {
      this._callbacks[timing] = [];
    }
  },

  async _restart() {
    lazy.log.debug("Restarting policy engine.");
    await this._resetEngine();

    // Simulate the startup process. This step-by-step is a bit ugly but it
    // tries to emulate the same behavior as of a normal startup.
    let notifyTopicOnIdle = topic =>
      new Promise(resolve => {
        ChromeUtils.idleDispatch(() => {
          this.observe(null, topic, "");
          resolve();
        });
      });
    await notifyTopicOnIdle("policies-startup");
    await notifyTopicOnIdle("profile-after-change");
    await notifyTopicOnIdle("final-ui-startup");
    await notifyTopicOnIdle("sessionstore-windows-restored");
    await notifyTopicOnIdle("distribution-customization-complete");
  },

  _topicsObserved: new Set(),

  topicByCallbackTiming: {
    onBeforeAddons: "policies-startup",
    onProfileAfterChange: "profile-after-change",
    onBeforeUIStartup: "final-ui-startup",
    onAllWindowsRestored: "sessionstore-windows-restored",
  },

  // nsIObserver implementation
  observe(aSubject, aTopic) {
    lazy.log.debug(`Observed topic: ${aTopic}.`);
    this._topicsObserved.add(aTopic);

    switch (aTopic) {
      case "policies-startup": {
        // _initialize() does async work (fetching remote policies).
        // We spin a nested event loop until the promise resolves so
        // this observer doesn't return before initialization completes.
        // This keeps startup behavior effectively synchronous.
        const initializedPromise = this._initialize();
        this.spinResolve(initializedPromise);
        this._runPoliciesCallbacks("onBeforeAddons");
        Services.obs.notifyObservers(null, "EnterprisePolicies:Initialized");
        break;
      }
      case "profile-after-change":
        this._runPoliciesCallbacks("onProfileAfterChange");
        break;

      case "final-ui-startup":
        this._runPoliciesCallbacks("onBeforeUIStartup");
        break;

      case "sessionstore-windows-restored":
        this._runPoliciesCallbacks("onAllWindowsRestored");
        break;

      case "EnterprisePolicies:Reset":
        this._resetEngine().catch(lazy.log.error);
        break;

      case "EnterprisePolicies:Restart":
        this._restart().catch(lazy.log.error);
        break;

      case "EnterprisePolicies:Update": {
        this._updatePolicies();
        Services.obs.notifyObservers(
          null,
          "EnterprisePolicies:PolicyUpdatesApplied"
        );
        break;
      }

      case "distribution-customization-complete":
        this._reportEnterpriseTelemetry();

        // Notify the test observer when the last message
        // is received.
        Services.obs.notifyObservers(
          null,
          "EnterprisePolicies:AllPoliciesApplied"
        );

        break;
    }
  },

  messageDisallowedFeatures(neededOnContentProcess = false) {
    // NOTE: For optimization purposes, only features marked as needed
    // on content process will be passed onto the child processes.
    if (neededOnContentProcess) {
      Services.ppmm.sharedData.set(
        "EnterprisePolicies:DisallowedFeatures",
        new Set(
          Object.keys(DisallowedFeatures).filter(key => DisallowedFeatures[key])
        )
      );
    }
  },

  disallowFeature(feature, neededOnContentProcess = false) {
    DisallowedFeatures[feature] = neededOnContentProcess;
    this.messageDisallowedFeatures(neededOnContentProcess);
  },

  allowFeature(feature, neededOnContentProcess = false) {
    delete DisallowedFeatures[feature];
    this.messageDisallowedFeatures(neededOnContentProcess);
  },

  updateSitePolicies(policies) {
    SitePolicies = policies;

    let clonable = policies.map(policy => ({
      match: policy.match.patterns.map(p => p.pattern),
      exceptions: policy.exceptions.patterns.map(p => p.pattern),
      features: policy.features,
    }));

    Services.ppmm.sharedData.set("EnterprisePolicies:SitePolicies", clonable);
  },

  // ------------------------------
  // public nsIEnterprisePolicies members
  // ------------------------------

  _status: Ci.nsIEnterprisePolicies.UNINITIALIZED,

  set status(val) {
    lazy.log.debug(`Setting engine status to ${STATUS_NAMES[val] ?? val}.`);
    this._status = val;
    if (val != Ci.nsIEnterprisePolicies.INACTIVE) {
      Services.ppmm.sharedData.set("EnterprisePolicies:Status", val);
    }
  },

  get status() {
    return this._status;
  },

  isAllowed(feature) {
    return !(feature in DisallowedFeatures);
  },

  isAllowedForURI(feature, uri) {
    return lazy.SitePolicyUtils.isAllowedForURI(
      this,
      SitePolicies,
      feature,
      uri
    );
  },

  hasSitePoliciesForURI(uri) {
    return lazy.SitePolicyUtils.hasSitePoliciesForURI(SitePolicies, uri);
  },

  getActivePolicies() {
    return this._parsedPolicies;
  },

  setSupportMenu(supportMenu) {
    SupportMenu = supportMenu;
  },

  getSupportMenu() {
    return SupportMenu;
  },

  setExtensionPolicies(extensionPolicies) {
    ExtensionPolicies = extensionPolicies;
  },

  getExtensionPolicy(extensionID) {
    if (ExtensionPolicies && extensionID in ExtensionPolicies) {
      return ExtensionPolicies[extensionID];
    }
    return null;
  },

  setExtensionSettings(extensionSettings) {
    // Filter blocked_permissions entries to the same shape Chrome's policy
    // schema enforces:
    //   "items": { "pattern": "^[a-z][a-zA-Z0-9._]*$", "type": "string" }
    // This excludes:
    //   - "internal:"-prefixed permissions (reserved, must not be controlled
    //     via enterprise policy)
    //   - match patterns and "<all_urls>" (host permissions are out of scope
    //     for blocked_permissions; in Firefox, "<all_urls>" is stored under
    //     the ExtensionPermissions "permissions" key so an unfiltered entry
    //     would erroneously affect host permission semantics)
    // Copies the input rather than mutating the caller's object.
    // toolkit/components/extensions/test/xpcshell/test_ext_permissions.js
    // asserts every API permission name matches this regex.
    // allowed_permissions needs no filtering: it only ever subtracts from the
    // already-filtered blocked_permissions, so an out-of-shape entry can never
    // match and has no effect.
    const VALID_PERM = /^[a-z][a-zA-Z0-9._]*$/;
    const sanitized = {};
    for (const [key, entry] of Object.entries(extensionSettings)) {
      if (Array.isArray(entry?.blocked_permissions)) {
        sanitized[key] = {
          ...entry,
          blocked_permissions: entry.blocked_permissions.filter(perm =>
            VALID_PERM.test(perm)
          ),
        };
      } else {
        sanitized[key] = entry;
      }
    }
    ExtensionSettings = sanitized;
    if (
      "*" in extensionSettings &&
      "install_sources" in extensionSettings["*"]
    ) {
      InstallSources = new MatchPatternSet(
        extensionSettings["*"].install_sources
      );
    }
  },

  getExtensionSettings(extensionID) {
    if (!ExtensionSettings) {
      return null;
    }
    const perIdEntry =
      extensionID in ExtensionSettings ? ExtensionSettings[extensionID] : null;
    let settings = perIdEntry ?? ExtensionSettings["*"];
    if (!settings) {
      return null;
    }
    if (
      perIdEntry &&
      settings.installation_mode === "force_installed" &&
      !("updates_disabled" in settings)
    ) {
      settings = { ...settings, updates_disabled: false };
    }
    // Resolve the effective blocked_permissions. Per-id replaces "*";
    // per-id allowed_permissions unblocks its own; "*"-level is inert.
    let blocked = settings.blocked_permissions ?? [];
    if (perIdEntry && Array.isArray(perIdEntry.allowed_permissions)) {
      const allowedSet = new Set(perIdEntry.allowed_permissions);
      blocked = blocked.filter(perm => !allowedSet.has(perm));
    }
    return { ...settings, blocked_permissions: blocked };
  },

  isAddonRequiredByPolicy(addonID) {
    const policySettings = this.getExtensionSettings(addonID);
    const legacyLockedSettings =
      this.getActivePolicies()?.Extensions?.Locked ?? [];
    return (
      ["force_installed", "normal_installed"].includes(
        policySettings?.installation_mode
      ) || legacyLockedSettings.includes(addonID)
    );
  },

  /**
   * @param {object} addon
   * @param {string} addon.id
   * @param {string} addon.type
   * @param {string[]} [addon.permissions]
   *   Required permissions; omit when unavailable (treated as none).
   * @returns {boolean} Whether policy permits installing the add-on.
   */
  mayInstallAddon({ id, type, permissions = [] }) {
    // See https://dev.chromium.org/administrators/policy-list-3/extension-settings-full
    if (!ExtensionSettings) {
      return true;
    }
    // blocked_permissions takes precedence over installation_mode; the
    // effective list (which accounts for allowed_permissions) is resolved by
    // getExtensionSettings. Optional permissions are gated at
    // permissions.request time instead.
    let blockedPerms = this.getExtensionSettings(id)?.blocked_permissions ?? [];
    if (blockedPerms.some(perm => permissions.includes(perm))) {
      return false;
    }
    // Match Chrome: any per-id ExtensionSettings entry (even empty) shadows
    // the "*" defaults entirely.
    if (id in ExtensionSettings) {
      if (ExtensionSettings[id].installation_mode === "blocked") {
        return false;
      }
      return true;
    }
    if ("*" in ExtensionSettings) {
      if (
        ExtensionSettings["*"].installation_mode &&
        ExtensionSettings["*"].installation_mode == "blocked"
      ) {
        return false;
      }
      if ("allowed_types" in ExtensionSettings["*"]) {
        return ExtensionSettings["*"].allowed_types.includes(type);
      }
    }
    return true;
  },

  allowedInstallSource(uri) {
    return InstallSources ? InstallSources.matches(uri) : true;
  },

  isExemptExecutableExtension(url, extension) {
    let urlObject = URL.parse(url);
    if (!urlObject) {
      return false;
    }
    let { hostname } = urlObject;
    let exemptArray =
      this.getActivePolicies()
        ?.ExemptDomainFileTypePairsFromFileTypeDownloadWarnings;
    if (!hostname || !extension || !exemptArray) {
      return false;
    }
    extension = extension.toLowerCase();
    let domains = exemptArray
      .filter(item => item.file_extension.toLowerCase() == extension)
      .map(item => item.domains)
      .flat();
    for (let domain of domains) {
      if (Services.eTLD.hasRootDomain(hostname, domain)) {
        return true;
      }
    }
    return false;
  },

  get isEnterprise() {
    let excludedDistributionIDs = [
      "mozilla-mac-eol-esr115",
      "mozilla-win-eol-esr115",
    ];
    let distroId = Services.prefs
      .getDefaultBranch(null)
      .getCharPref("distribution.id", "");

    let policiesLength = Object.keys(this._parsedPolicies || {}).length;

    let isEnterprise =
      // As we migrate folks to ESR for other reasons (deprecating an OS),
      // we need to add checks here for distribution IDs.
      (AppConstants.IS_ESR && !excludedDistributionIDs.includes(distroId)) ||
      // If there are policies then its enterprise.
      policiesLength > 0;

    return isEnterprise;
  },

  /**
   * Spin the event loop until the passed promise resolves.
   *
   * @param {Promise} promise
   * @returns {any} Result of the resolved promise
   */
  spinResolve(promise) {
    if (!(promise instanceof Promise)) {
      return promise;
    }
    let done = false;
    let result = null;
    let error = null;
    promise
      .catch(e => {
        error = e;
      })
      .then(r => {
        result = r;
        done = true;
      });

    Services.tm.spinEventLoopUntil(
      "EnterprisePoliciesManager.sys.mjs:_initialize",
      () => done
    );
    if (!done) {
      throw new Error("Forcefully exited event loop.");
    } else if (error) {
      throw error;
    } else {
      return result;
    }
  },
};

let DisallowedFeatures = {};
let SitePolicies = [];
let SupportMenu = null;
let ExtensionPolicies = null;
let ExtensionSettings = null;
let InstallSources = null;

/**
 * Basic policies provider
 */
class PoliciesProvider {
  constructor() {
    this._policies = {};
    this._failed = false;
  }

  get policies() {
    return this._policies;
  }

  get hasPolicies() {
    return this._policies !== null && !isEmptyObject(this._policies);
  }

  get failed() {
    return this._failed;
  }
}

/*
 * JSON PROVIDER OF POLICIES
 *
 * This is a platform-agnostic provider which looks for
 * policies specified through a policies.json file stored
 * in the installation's distribution folder.
 */

class JSONPoliciesProvider extends PoliciesProvider {
  constructor() {
    super();
    this._readData();
  }

  _getLocalConfigurationFile() {
    if (shouldIgnoreLocalPolicies()) {
      return null;
    }

    if (AppConstants.platform == "linux" && AppConstants.MOZ_SYSTEM_POLICIES) {
      let systemConfigFile = Services.dirsvc.get("SysConfD", Ci.nsIFile);
      systemConfigFile.append("policies");
      systemConfigFile.append(POLICIES_FILENAME);
      if (systemConfigFile.exists()) {
        return systemConfigFile;
      }
    }

    try {
      let configFile;
      let perUserPath = Services.prefs.getBoolPref(PREF_PER_USER_DIR, false);
      if (perUserPath) {
        configFile = Services.dirsvc.get("XREUserRunTimeDir", Ci.nsIFile);
      } else {
        configFile = Services.dirsvc.get("XREAppDist", Ci.nsIFile);
      }
      configFile.append(POLICIES_FILENAME);
      return configFile;
    } catch (ex) {
      // Getting the correct directory will fail in xpcshell tests. This should
      // be handled the same way as if the configFile simply does not exist.
      return null;
    }
  }

  _getConfigurationFile() {
    let configFile = this._getLocalConfigurationFile();

    let alternatePath = Services.prefs.getStringPref(PREF_ALTERNATE_PATH, "");

    // Check if we are in automation *before* we use the synchronous
    // nsIFile.exists() function or allow the config file to be overriden
    // An alternate policy path can also be used in Nightly builds (for
    // testing purposes), but the Background Update Agent will be unable to
    // detect the alternate policy file so the DisableAppUpdate policy may not
    // work as expected.
    if (
      alternatePath &&
      (Cu.isInAutomation || AppConstants.NIGHTLY_BUILD) &&
      (!configFile || !configFile.exists())
    ) {
      if (alternatePath.startsWith(MAGIC_TEST_ROOT_PREFIX)) {
        // Intentionally not using a default value on this pref lookup. If no
        // test root is set, we are not currently testing and this function
        // should throw rather than returning something.
        let testRoot = Services.prefs.getStringPref(PREF_TEST_ROOT);
        let relativePath = alternatePath.substring(
          MAGIC_TEST_ROOT_PREFIX.length
        );
        if (AppConstants.platform == "win") {
          relativePath = relativePath.replace(/\//g, "\\");
        }
        alternatePath = testRoot + relativePath;
      }

      configFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      configFile.initWithPath(alternatePath);
    }

    return configFile;
  }

  _readData() {
    let configFile = this._getConfigurationFile();
    if (!configFile) {
      // Do nothing, _policies will remain null
      return;
    }
    try {
      let data = Cu.readUTF8File(configFile);
      if (data) {
        lazy.log.debug(`policies.json path = ${configFile.path}`);
        lazy.log.debug(`policies.json content = ${data}`);
        const { policies } = JSON.parse(data);

        if (!policies) {
          lazy.log.error("Policies file doesn't contain a 'policies' object");
          this._policies = null;
          this._failed = true;
        } else {
          this._policies = policies;
        }
      }
    } catch (ex) {
      if (
        ex instanceof Components.Exception &&
        ex.result == Cr.NS_ERROR_FILE_NOT_FOUND
      ) {
        // Do nothing, _policies will remain null
      } else if (ex instanceof SyntaxError) {
        lazy.log.error(`Error parsing JSON file: ${ex}`);
        this._failed = true;
      } else {
        lazy.log.error(`Error reading JSON file: ${ex}`);
        this._failed = true;
      }
    }
  }
}

/*
 * Remote PROVIDER OF POLICIES
 *
 * This is a platform-agnostic provider which
 * polls policies from a remote server.
 *
 * Uses JSON like JSONPoliciesProvider
 */
class RemotePoliciesProvider extends PoliciesProvider {
  POLLING_FREQUENCY_PREF = "enterprise.policies.live.polling_interval";
  POLLING_FREQUENCY_FALLBACK = 60_000;

  static #instance = null;
  static getInstance() {
    if (!this.#instance) {
      this.#instance = new this();
    }
    return this.#instance;
  }

  static dropInstance() {
    if (!this.#instance) {
      // No instance was initialized.
      return;
    }
    this.#instance._destroy();
    this.#instance = null;
  }

  constructor() {
    super();
    this._poller = null;
    this._updateInProgress = false;
    this._lastPoliciesHash = null;
    this._pollingFrequency = Services.prefs.getIntPref(
      this.POLLING_FREQUENCY_PREF,
      this.POLLING_FREQUENCY_FALLBACK
    );
    Services.prefs.addObserver(this.POLLING_FREQUENCY_PREF, this);
    Services.obs.addObserver(this, "EnterprisePolicies:Initialized");
    Services.obs.addObserver(this, "xpcom-shutdown");
  }

  _destroy() {
    this._stopPolling();
    Services.prefs.removeObserver(this.POLLING_FREQUENCY_PREF, this);
    Services.obs.removeObserver(this, "EnterprisePolicies:Initialized");
    Services.obs.removeObserver(this, "xpcom-shutdown");
  }

  /**
   * Whether the remote policies request that all local policy providers be
   * disabled.
   *
   * @returns {boolean}
   */
  get disablesLocalPolicies() {
    return this._policies?.[POLICY_DISABLE_LOCAL_POLICIES] === true;
  }

  observe(aSubject, aTopic, aData) {
    switch (aTopic) {
      case "EnterprisePolicies:Initialized":
        this._startPolling();
        break;
      case "nsPref:changed":
        if (aData === this.POLLING_FREQUENCY_PREF) {
          const p = this._pollingFrequency;
          this._pollingFrequency = Services.prefs.getIntPref(
            this.POLLING_FREQUENCY_PREF,
            this.POLLING_FREQUENCY_FALLBACK
          );
          if (p === this._pollingFrequency) {
            // Nothing changed
            return;
          }
          lazy.log.debug(
            `Remote policy polling interval changed from ${p}ms to ${this._pollingFrequency}ms.`
          );
          this._stopPolling();
          this._startPolling();
        }
        break;
      case "xpcom-shutdown":
        this._destroy();
        break;
    }
  }

  _stopPolling() {
    if (!this._poller) {
      return;
    }
    lazy.log.debug("Stopping live policy polling.");
    lazy.clearInterval(this._poller);
    this._poller = null;
  }

  async _performPolling() {
    if (this._updateInProgress) {
      // A previous update (fetch and synchronous apply) is still in
      // progress; skip this tick to avoid overlapping updates.
      lazy.log.debug("Skipping poll, a previous update is still in progress.");
      return;
    }
    this._updateInProgress = true;
    try {
      lazy.log.debug("Polling for remote policies.");
      const changed = await this.ingestPolicies({ isStartup: false });
      if (!changed) {
        lazy.log.debug("Remote policies unchanged, not firing an update.");
        return;
      }
      lazy.log.debug("Remote policies changed; firing update.");
      Services.obs.notifyObservers(null, "EnterprisePolicies:Update");
    } catch (e) {
      lazy.log.error(
        `RemotePoliciesProvider performPolling() with frequency ${this._pollingFrequency} caused error`,
        e
      );
    } finally {
      this._updateInProgress = false;
    }
  }

  _startPolling() {
    if (this._poller) {
      // Already polling.
      return;
    }
    lazy.log.debug(
      `Starting live policy polling every ${this._pollingFrequency}ms.`
    );
    this._performPolling();
    this._poller = lazy.setInterval(
      this._performPolling.bind(this),
      this._pollingFrequency
    );
  }

  /**
   * Fetch the remote policies and store them.
   *
   * @param {object} [options]
   * @param {boolean} [options.isStartup=true] passed through to
   *   ConsoleClient.getRemotePolicies(); see its documentation.
   * @returns {Promise<boolean>} whether the policies or the failure state
   *   changed, i.e. whether the engine should re-evaluate
   */
  async ingestPolicies({ isStartup = true } = {}) {
    const res = await lazy.ConsoleClient.getRemotePolicies({ isStartup });
    if (!res?.policies) {
      lazy.log.error(
        `No policies were found in the response: ${JSON.stringify(res)}.`
      );
      const wasFailed = this._failed;
      this._failed = true;
      // A new failure must refresh the engine status to FAILED
      return !wasFailed;
    }

    const wasFailed = this._failed;
    this._failed = false;
    this._policies = res.policies;

    if (wasFailed) {
      lazy.log.warn(
        "RemotePoliciesProvider recovered after a previous failure."
      );
    }

    // The console returns byte-identical JSON when the remote policy set is
    // unchanged, so hashing it lets us skip firing an update when nothing
    // changed. Recovering from a failure must refresh the status too, even if
    // the payload matches the last good set.
    const policiesHash = hashValue(this._policies);
    const changed = policiesHash !== this._lastPoliciesHash || wasFailed;
    this._lastPoliciesHash = policiesHash;
    return changed;
  }
}

class WindowsGPOPoliciesProvider extends PoliciesProvider {
  constructor() {
    super();
    let wrk = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
      Ci.nsIWindowsRegKey
    );

    // Machine policies override user policies, so we read
    // user policies first and then replace them if necessary.
    this._readData(wrk, wrk.ROOT_KEY_CURRENT_USER);
    // We don't access machine policies in testing
    if (!Cu.isInAutomation) {
      this._readData(wrk, wrk.ROOT_KEY_LOCAL_MACHINE);
    }
  }

  _readData(wrk, root) {
    try {
      let regLocation = "SOFTWARE\\Policies";
      if (Cu.isInAutomation) {
        let altLocation = Services.prefs.getStringPref(PREF_ALTERNATE_GPO, "");
        if (altLocation) {
          regLocation = altLocation;
        } else if (shouldIgnoreLocalPolicies()) {
          return;
        }
      }
      wrk.open(root, regLocation, wrk.ACCESS_READ);
      if (wrk.hasChild("Mozilla\\" + Services.appinfo.name)) {
        lazy.log.debug(
          `root = ${
            root == wrk.ROOT_KEY_CURRENT_USER
              ? "HKEY_CURRENT_USER"
              : "HKEY_LOCAL_MACHINE"
          }`
        );
        this._policies = lazy.WindowsGPOParser.readPolicies(
          wrk,
          this._policies
        );
      }
      wrk.close();
    } catch (e) {
      lazy.log.error("Unable to access registry - ", e);
    }
  }
}

class macOSPoliciesProvider extends PoliciesProvider {
  constructor() {
    super();
    let prefReader = Cc["@mozilla.org/mac-preferences-reader;1"].createInstance(
      Ci.nsIMacPreferencesReader
    );
    if (!prefReader.policiesEnabled()) {
      return;
    }
    this._policies = lazy.macOSPoliciesParser.readPolicies(prefReader) || {};
  }
}

export class CombinedProvider extends PoliciesProvider {
  constructor() {
    super();
    this._providers = [];
  }

  /**
   * Add a provider. It takes precedence over any previously added providers
   * when merging conflicting top-level policies.
   *
   * @param {PoliciesProvider} provider provider to add
   */
  push(provider) {
    this._providers.push(provider);
  }

  mergePolicies() {
    // Combine the top-level policies of every provider, with providers added
    // later taking precedence over those added earlier.
    this._policies = Object.assign({}, ...this._providers.map(p => p.policies));
  }

  get failed() {
    // A failed provider only fails the engine if it left us without any
    // policies to apply. If any provider supplied policies we proceed
    // and ignore the failed source.
    return this._providers.some(p => p.failed) && !this.hasPolicies;
  }
}
