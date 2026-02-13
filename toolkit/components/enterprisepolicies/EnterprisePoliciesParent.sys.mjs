/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  JsonSchemaValidator:
    "resource://gre/modules/components-utils/JsonSchemaValidator.sys.mjs",
  // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
  Policies: "resource:///modules/policies/Policies.sys.mjs",
  WindowsGPOParser: "resource://gre/modules/policies/WindowsGPOParser.sys.mjs",
  macOSPoliciesParser:
    "resource://gre/modules/policies/macOSPoliciesParser.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
  ConsoleClient: "resource:///modules/enterprise/ConsoleClient.sys.mjs",
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

export const PREF_REMOTE_POLICIES_ENABLED = "browser.policies.remote.enabled";
export const PREF_LOCAL_POLICIES_ENABLED = "browser.policies.local.enabled";

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

const isXpcshell = Services.env.exists("XPCSHELL_TEST_PROFILE_DIR");

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

  _isRemotePoliciesSupported() {
    return (
      AppConstants.MOZ_ENTERPRISE &&
      Services.prefs.getBoolPref(PREF_REMOTE_POLICIES_ENABLED, false)
    );
  },

  _isLocalPoliciesSupported() {
    return (
      !AppConstants.MOZ_ENTERPRISE ||
      Services.prefs.getBoolPref(PREF_LOCAL_POLICIES_ENABLED, true)
    );
  },

  _cleanupPolicies() {
    if (Services.prefs.getBoolPref(PREF_POLICIES_APPLIED, false)) {
      if ("_cleanup" in lazy.Policies) {
        let policyImpl = lazy.Policies._cleanup;
        this._scheduleActivationPolicyCallbacks(policyImpl);
      }
      Services.prefs.clearUserPref(PREF_POLICIES_APPLIED);
    }
  },

  async _initialize() {
    this._cleanupPolicies();

    this._policiesSchema = ChromeUtils.importESModule(
      "resource:///modules/policies/schema.sys.mjs"
    ).schema;

    Services.prefs.setBoolPref(PREF_POLICIES_APPLIED, false);

    let localProvider;
    if (this._isLocalPoliciesSupported()) {
      localProvider = this._chooseProvider();
    }

    if (this._isRemotePoliciesSupported()) {
      const remoteProvider = RemotePoliciesProvider.getInstance();
      try {
        // Poll and ingest initial set of policies
        await remoteProvider.ingestPolicies();
        // Will apply policy updates once policies manager is initialized
        remoteProvider.startPolling();
      } catch (e) {
        console.error("Unable to find policies in payload.");
      }
      if (localProvider?.hasPolicies) {
        this._provider = new CombinedProvider(remoteProvider, localProvider);
      } else {
        this._provider = remoteProvider;
      }
    } else {
      this._provider = localProvider;
    }

    if (!this._provider) {
      // Both local and remote policy provision is disabled.
      this.status = Ci.nsIEnterprisePolicies.INACTIVE;
      return;
    }

    if (this._provider.failed) {
      this.status = Ci.nsIEnterprisePolicies.FAILED;
      return;
    }

    if (!this._provider.hasPolicies) {
      this.status = Ci.nsIEnterprisePolicies.INACTIVE;
      return;
    }

    // Because security.enterprise_roots.enabled is true by default, we can
    // ignore attempts by Antivirus to try to set it via policy.
    // We have to explicitly check for true or 1 because this happens before
    // policy is parsed against the schema, so the value could be coming
    // from the registry.
    const policies = this._provider.policies;
    if (
      Object.keys(policies).length === 1 &&
      policies.Certificates &&
      Object.keys(policies.Certificates).length === 1 &&
      (policies.Certificates.ImportEnterpriseRoots === true ||
        policies.Certificates.ImportEnterpriseRoots === 1)
    ) {
      this.status = Ci.nsIEnterprisePolicies.INACTIVE;
      return;
    }

    this._activatePolicies();
  },

  _reportEnterpriseTelemetry() {
    Glean.policies.count.set(Object.keys(this._parsedPolicies || {}).length);
    Glean.policies.isEnterprise.set(this.isEnterprise);
  },

  _chooseProvider() {
    let platformProvider = null;
    if (AppConstants.MOZ_SYSTEM_POLICIES) {
      if (AppConstants.platform == "win") {
        platformProvider = new WindowsGPOPoliciesProvider();
      } else if (AppConstants.platform == "macosx") {
        platformProvider = new macOSPoliciesProvider();
      }
    }
    let jsonProvider = new JSONPoliciesProvider();
    if (platformProvider && platformProvider.hasPolicies) {
      if (jsonProvider.hasPolicies) {
        return new CombinedProvider(platformProvider, jsonProvider);
      }
      return platformProvider;
    }
    return jsonProvider;
  },

  /**
   * Update engine status after parsing policies
   */
  _updateStatus() {
    if (this._provider.failed) {
      this.status = Ci.nsIEnterprisePolicies.FAILED;
    } else if (this.hasActivePolicies()) {
      this.status = Ci.nsIEnterprisePolicies.ACTIVE;
    } else {
      this.status = Ci.nsIEnterprisePolicies.INACTIVE;
    }
  },

  /**
   * Activates the policies that are provided during initialization.
   */
  _activatePolicies() {
    for (const [policyName, policyParams] of Object.entries(
      this._provider.policies || {}
    )) {
      const { isValid, parsedParams } = this._validatePolicyParams(
        policyName,
        policyParams
      );

      if (!isValid) {
        console.warn(`Parameters for policy ${policyName} are invalid`);
        continue;
      }

      this._parsedPolicies[policyName] = parsedParams;

      const policyImpl = lazy.Policies[policyName];
      this._scheduleActivationPolicyCallbacks(policyImpl, parsedParams);
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
    if (this.status === Ci.nsIEnterprisePolicies.UNINITIALIZED) {
      // Abort if we are still initializing or restarting the policy engine.
      return;
    }

    if (this._provider.isCombined) {
      this._provider.mergePolicies();
    }

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

    for (const timing of Object.keys(this._callbacks)) {
      if (timing !== "onRemove") {
        const topic = this.topicByCallbackTiming[timing];
        if (!this._topicsObserved.has(topic)) {
          // Only run callbacks for a timing that
          // has already been observed.
          continue;
        }
      }
      this._runPoliciesCallbacks(timing);
    }

    this._updateStatus();
  },

  /**
   * Parse and schedule a policy update
   *
   * @param {object} previousPolicies
   */
  _schedulePolicyUpdates(previousPolicies) {
    this._parsedPolicies = {};

    for (const [policyName, policyParams] of Object.entries(
      this._provider.policies || {}
    )) {
      const { isValid, parsedParams } = this._validatePolicyParams(
        policyName,
        policyParams
      );

      if (!isValid) {
        continue;
      }

      this._parsedPolicies[policyName] = parsedParams;

      // verify the previous values
      if (policyName in previousPolicies) {
        const previousParameters = JSON.stringify(previousPolicies[policyName]);
        if (previousParameters == JSON.stringify(parsedParams)) {
          // Policy already active. No changes to policy needed.
          continue;
        }
      }

      const policyImpl = lazy.Policies[policyName];
      this._scheduleActivationPolicyCallbacks(policyImpl, parsedParams);
    }
  },

  /**
   * Schedule policy removals
   *
   * @param {object} previousPolicies
   */
  _schedulePolicyRemovals(previousPolicies) {
    // Schedule callbacks to remove policies that are no longer present
    // in the latest set of parsed policies.
    for (const [policyName, policyParams] of Object.entries(previousPolicies)) {
      if (this._parsedPolicies[policyName] !== undefined) {
        // Policy remains active.
        continue;
      }

      const policyImpl = lazy.Policies[policyName];
      if (!policyImpl) {
        // This means there is an entry in the schema, but no implementation.
        // We only do this when we deprecate policies.
        lazy.log.warn(`The policy ${policyName} has been deprecated.`);
        continue;
      }

      if (!policyImpl.onRemove) {
        lazy.log.warn(`Unable to remove the policy ${policyName}.`);
        continue;
      }

      this._schedulePolicyCallback("onRemove", [
        policyImpl.onRemove,
        policyImpl,
        this /* the EnterprisePoliciesManager */,
        policyParams,
      ]);
    }
  },

  /**
   * Validate and parse the policy parameters
   *
   * @param {object} policyName policy name
   * @param {object} policyParams policy parameters
   * @returns {{ isValid: boolean, parsedParams: object|null}}
   */
  _validatePolicyParams(policyName, policyParams) {
    const policySchema = this._policiesSchema.properties[policyName];

    if (!policySchema) {
      lazy.log.error(`Unknown policy: ${policyName}`);
      return { isValid: false, parsedParams: null };
    }

    const { valid: isValid, parsedValue: parsedParams } =
      lazy.JsonSchemaValidator.validate(policyParams, policySchema, {
        allowAdditionalProperties: true,
      });

    if (!isValid) {
      lazy.log.error(`Invalid parameters specified for ${policyName}.`);
      return { isValid: false, parsedParams: null };
    }

    const policyImpl = lazy.Policies[policyName];
    if (!policyImpl) {
      // This means there is an entry in the schema, but no implementaton.
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
   * @property {Function} [onRemove] - callback that is invoked when a policy is explicitely removed
   */

  /**
   * Schedule all "activating" callbacks, meaning any
   * "onRemove" callbacks are skipped
   *
   * @param {PolicyImpl} policyImpl policy implementation
   * @param {object} [parsedParams] parsed policy parameters
   */
  _scheduleActivationPolicyCallbacks(policyImpl, parsedParams = undefined) {
    for (let timing of Object.keys(this._callbacks)) {
      if (timing === "onRemove") {
        // Callbacks that remove policies are explicitely scheduled.
        continue;
      }

      let policyCallback = policyImpl[timing];
      if (policyCallback) {
        this._schedulePolicyCallback(timing, [
          policyCallback,
          policyImpl,
          this /* the EnterprisePoliciesManager */,
          parsedParams,
        ]);
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

  _schedulePolicyCallback(timing, callbackArgs) {
    // Check for existence of the same callback. Since callback are .bind()
    // they cannot be just pushed to the array and checked for existence with
    // .includes() as each bind is a new different object.
    //
    // Instead the array contains everything:
    //  - policyCallback,
    //  - policyImpl,
    //  - this reference
    //  - parsedParameters
    //
    // And we manually check for pre-existence of all. The parsedParameters
    // may differ at the object level so we force the comparison with
    // JSON.stringify()

    const exists = this._callbacks[timing].filter(
      e =>
        e[0] == callbackArgs[0] &&
        e[1] == callbackArgs[1] &&
        e[2] == callbackArgs[2] &&
        JSON.stringify(e[3]) == JSON.stringify(callbackArgs[3])
    );
    if (exists.length) {
      return;
    }
    this._callbacks[timing].push(callbackArgs);
  },

  _runPoliciesCallbacks(timing) {
    let callbacks = this._callbacks[timing];
    while (callbacks.length) {
      let [policyCallback, policyImpl, self, parsedParameters] =
        callbacks.shift();
      const callback = policyCallback.bind(policyImpl, self, parsedParameters);
      try {
        callback();
      } catch (ex) {
        lazy.log.error("Error running ", callback, `for ${timing}:`, ex);
      }
    }
  },

  async _resetEngine() {
    DisallowedFeatures = {};

    Services.ppmm.sharedData.delete("EnterprisePolicies:Status");
    Services.ppmm.sharedData.delete("EnterprisePolicies:DisallowedFeatures");

    this.status = Ci.nsIEnterprisePolicies.UNINITIALIZED;
    this._parsedPolicies = {};
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
    this._topicsObserved.add(aTopic);

    switch (aTopic) {
      case "policies-startup": // Before the first set of policy callbacks runs, we must
        // initialize the service.
        {
          const initializedPromise = this._initialize();
          this.spinResolve(initializedPromise);
          this._runPoliciesCallbacks("onBeforeAddons");
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
        this._resetEngine().catch(console.error);
        break;

      case "EnterprisePolicies:Restart":
        this._restart().catch(console.error);
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

  // ------------------------------
  // public nsIEnterprisePolicies members
  // ------------------------------

  _status: Ci.nsIEnterprisePolicies.UNINITIALIZED,

  set status(val) {
    this._status = val;
    if (val != Ci.nsIEnterprisePolicies.INACTIVE) {
      Services.ppmm.sharedData.set("EnterprisePolicies:Status", val);
    }
  },

  get status() {
    return this._status;
  },

  isAllowed: function BG_sanitize(feature) {
    return !(feature in DisallowedFeatures);
  },

  getActivePolicies() {
    return this._parsedPolicies;
  },

  hasActivePolicies() {
    return !!Object.keys(this._parsedPolicies || {}).length;
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
    ExtensionSettings = extensionSettings;
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
    let settings = null;
    if (ExtensionSettings) {
      if (extensionID in ExtensionSettings) {
        settings = ExtensionSettings[extensionID];
      } else if ("*" in ExtensionSettings) {
        settings = ExtensionSettings["*"];
      }
    }
    return settings;
  },

  mayInstallAddon(addon) {
    // See https://dev.chromium.org/administrators/policy-list-3/extension-settings-full
    if (!ExtensionSettings) {
      return true;
    }
    if (addon.id in ExtensionSettings) {
      if ("installation_mode" in ExtensionSettings[addon.id]) {
        switch (ExtensionSettings[addon.id].installation_mode) {
          case "blocked":
            return false;
          default:
            return true;
        }
      }
    }
    if ("*" in ExtensionSettings) {
      if (
        ExtensionSettings["*"].installation_mode &&
        ExtensionSettings["*"].installation_mode == "blocked"
      ) {
        return false;
      }
      if ("allowed_types" in ExtensionSettings["*"]) {
        return ExtensionSettings["*"].allowed_types.includes(addon.type);
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

  get isCombined() {
    return false;
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

  _getConfigurationFile() {
    let configFile = null;

    if (AppConstants.platform == "linux" && AppConstants.MOZ_SYSTEM_POLICIES) {
      let systemConfigFile = Services.dirsvc.get("SysConfD", Ci.nsIFile);
      systemConfigFile.append("policies");
      systemConfigFile.append(POLICIES_FILENAME);
      if (systemConfigFile.exists()) {
        return systemConfigFile;
      }
    }

    try {
      let perUserPath = Services.prefs.getBoolPref(PREF_PER_USER_DIR, false);
      if (perUserPath) {
        configFile = Services.dirsvc.get("XREUserRunTimeDir", Ci.nsIFile);
      } else {
        configFile = Services.dirsvc.get("XREAppDist", Ci.nsIFile);
      }
      configFile.append(POLICIES_FILENAME);
    } catch (ex) {
      // Getting the correct directory will fail in xpcshell tests. This should
      // be handled the same way as if the configFile simply does not exist.
    }

    let alternatePath = Services.prefs.getStringPref(PREF_ALTERNATE_PATH, "");

    // Check if we are in automation *before* we use the synchronous
    // nsIFile.exists() function or allow the config file to be overriden
    // An alternate policy path can also be used in Nightly builds (for
    // testing purposes), but the Background Update Agent will be unable to
    // detect the alternate policy file so the DisableAppUpdate policy may not
    // work as expected.
    if (
      alternatePath &&
      (Cu.isInAutomation || AppConstants.NIGHTLY_BUILD || isXpcshell) &&
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
          this._policies = {};
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
  POLLING_FREQUENCY_PREF = "browser.policies.live_polling.frequency";
  POLLING_FREQUENCY_FALLBACK = 60_000;
  POLLING_ENABLED_PREF = "browser.policies.live_polling.enabled";

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
    if (this.#instance._poller) {
      this.#instance._stopPolling();
    }
    this.#instance = null;
  }

  constructor() {
    super();
    this._poller = null;
    this._pollingFrequency = Services.prefs.getIntPref(
      this.POLLING_FREQUENCY_PREF,
      this.POLLING_FREQUENCY_FALLBACK
    );
    this._isPollingEnabled = Services.prefs.getBoolPref(
      this.POLLING_ENABLED_PREF,
      false
    );
    Services.prefs.addObserver(this.POLLING_FREQUENCY_PREF, this);
    Services.prefs.addObserver(this.POLLING_ENABLED_PREF, this);
    Services.obs.addObserver(this, "xpcom-shutdown");
  }

  observe(aSubject, aTopic, aData) {
    switch (aTopic) {
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
          this._stopPolling();
          this.startPolling();
        } else if (aData === this.POLLING_ENABLED_PREF) {
          const p = this._isPollingEnabled;
          this._isPollingEnabled = Services.prefs.getBoolPref(
            this.POLLING_ENABLED_PREF,
            false
          );
          if (p === this._isPollingEnabled) {
            return;
          }
          if (this._isPollingEnabled) {
            this.startPolling();
          } else {
            this._stopPolling();
          }
        }
        break;
      case "xpcom-shutdown":
        if (this._poller) {
          this._stopPolling();
        }
        Services.prefs.removeObserver(this.POLLING_FREQUENCY_PREF, this);
        Services.prefs.removeObserver(this.POLLING_ENABLED_PREF, this);
        Services.obs.removeObserver(this, "xpcom-shutdown");
        break;
    }
  }

  _stopPolling() {
    if (!this._poller) {
      return;
    }
    lazy.clearInterval(this._poller);
    this._poller = null;
  }

  async _performPolling() {
    try {
      await this.ingestPolicies();
      Services.obs.notifyObservers(null, "EnterprisePolicies:Update");
    } catch (e) {
      lazy.log.error(
        `RemotePoliciesProvider performPolling() with frequency ${this._pollingFrequency} caused error ${e}`
      );
    }
  }

  startPolling() {
    if (!this._isPollingEnabled) {
      return;
    }
    this._performPolling();
    this._poller = lazy.setInterval(
      this._performPolling.bind(this),
      this._pollingFrequency
    );
  }

  async ingestPolicies() {
    if (!this._isPollingEnabled) {
      return;
    }

    const res = await lazy.ConsoleClient.getRemotePolicies();
    if (!res.policies) {
      this._policies = {};
      console.error(
        `Clearing remote policies because no policies were found in the response: ${JSON.stringify(res)}.`
      );
      this._failed = true;
      return;
    }
    this._policies = res.policies;
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
    if (!Cu.isInAutomation && !isXpcshell) {
      this._readData(wrk, wrk.ROOT_KEY_LOCAL_MACHINE);
    }
  }

  _readData(wrk, root) {
    try {
      let regLocation = "SOFTWARE\\Policies";
      if (Cu.isInAutomation || isXpcshell) {
        try {
          regLocation = Services.prefs.getStringPref(PREF_ALTERNATE_GPO);
        } catch (e) {}
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

class CombinedProvider extends PoliciesProvider {
  constructor(primaryProvider, secondaryProvider) {
    super();
    this._primaryProvider = primaryProvider;
    this._secondaryProvider = secondaryProvider;
    this.mergePolicies();
  }

  mergePolicies() {
    // Combine policies with primaryProvider taking precedence.
    // We only do this for top level policies.
    this._policies = Object.assign({}, this._secondaryProvider.policies ?? {}, this._primaryProvider.policies);
  }

  get failed() {
    return this._primaryProvider.failed && this._secondaryProvider.failed;
  }

  get isCombined() {
    return true;
  }
}
