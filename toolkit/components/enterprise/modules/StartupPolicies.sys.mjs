/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("StartupPolicies");
});

/**
 * Policies Firefox reads before the policy engine exists, so they cannot be
 * delivered over the Felt IPC channel like other configuration points.
 * Felt fetches them before spawning the browser and passes them in the child's
 * environment; the native side checks each variable at its own read site.
 */
const STARTUP_POLICY_ENV_VARS = {
  DisableSafeMode: "MOZ_ENTERPRISE_DISABLE_SAFE_MODE",
  DisableThirdPartyModuleBlocking:
    "MOZ_ENTERPRISE_DISABLE_THIRD_PARTY_MODULE_BLOCKING",
};

/**
 * The startup policies resolved for one browser launch.
 */
export class StartupPolicies {
  #policies;

  constructor(policies = {}) {
    this.#policies = policies;
  }

  /**
   * Fetch the console's policy set and retain only the startup policies. A
   * failure is not fatal: the spawned browser polls the console itself at
   * policies-startup and reports the failure from there, so only the startup
   * policies are missed, and only for this launch.
   *
   * @returns {Promise<StartupPolicies>}
   */
  static async fetch() {
    let policies = {};
    try {
      const res = await lazy.ConsoleClient.getRemotePolicies();
      for (const name of Object.keys(STARTUP_POLICY_ENV_VARS)) {
        if (res?.policies?.[name] === true) {
          policies[name] = true;
        }
      }
    } catch (e) {
      lazy.log.error(`Failed to fetch the startup policies: ${e}`);
    }
    return new StartupPolicies(policies);
  }

  /**
   * @param {string} name - a key of STARTUP_POLICY_ENV_VARS
   * @returns {boolean} whether the console enabled that policy
   */
  isEnabled(name) {
    return this.#policies[name] === true;
  }

  /**
   * The environment with which to spawn the browser to apply the startup policies.
   *
   * @returns {object} environment variable name to "1"
   */
  get environment() {
    const environment = {};
    for (const [name, envVar] of Object.entries(STARTUP_POLICY_ENV_VARS)) {
      if (this.isEnabled(name)) {
        environment[envVar] = "1";
      }
    }
    return environment;
  }
}
