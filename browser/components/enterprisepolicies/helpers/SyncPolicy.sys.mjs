/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PREF_LOGLEVEL } from "resource:///modules/policies/Policies.sys.mjs";

import { STATUS_OK as SYNC_STATUS_OK } from "resource://services-sync/constants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PoliciesUtils: "resource://gre/modules/PoliciesHelpers.sys.mjs",
  Weave: "resource://services-sync/main.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return console.createInstance({
    prefix: "SyncPolicy",
    maxLogLevelPref: PREF_LOGLEVEL,
  });
});

const ENGINE_PREFS = {
  Addresses: "services.sync.engine.addresses",
  Addons: "services.sync.engine.addons",
  Bookmarks: "services.sync.engine.bookmarks",
  History: "services.sync.engine.history",
  OpenTabs: "services.sync.engine.tabs",
  Passwords: "services.sync.engine.passwords",
  PaymentMethods: "services.sync.engine.creditcards",
  Settings: "services.sync.engine.prefs",
};

const SYNC = "sync";
const SYNC_TABS = "sync-tabs";

// Engines whose data is especially sensitive and, in enterprise builds, is
// encrypted at rest but not end-to-end encrypted (the management console holds
// the key). Policy may turn these off (following the usual `Locked` handling),
// but must never turn them on: enabling them requires an explicit local opt-in
// from the user.
const CONSENT_REQUIRED_ENGINES = new Set(["Passwords", "PaymentMethods"]);

/**
 * Customizes Sync settings (all settings are optional):
 *    - Whether sync is enabled/disabled
 *    - Which types of data to sync
 *    - Whether to lock the sync customization
 * See SyncPolicyParams for details.
 */
export const SyncPolicy = {
  /**
   * Get current sync state.
   *
   * @returns {boolean} Whether sync is currently enabled.
   */
  isSyncCurrentlyEnabled() {
    return lazy.Weave.Status.checkSetup() == SYNC_STATUS_OK;
  },

  /**
   * @typedef {object} SyncPolicyParams
   * @property {boolean} [Enabled] Whether the feature sync should be enabled
   * @property {boolean} [Locked] Whether to lock the customized sync settings, hence
   *                              the user modifications/preferences will be overridden.
   *
   * // Per-engine sync configuration
   * @property {boolean} [Addons] Whether syncing addons should be enabled
   * @property {boolean} [Addresses] Whether syncing addresses should be enabled
   * @property {boolean} [Bookmarks] Whether syncing bookmarks should be enabled
   * @property {boolean} [History] Whether syncing history should be enabled
   * @property {boolean} [OpenTabs] Whether syncing open tabs should be enabled
   * @property {boolean} [Passwords] May only disable syncing passwords (false).
   *                                 A request to enable it is ignored: enabling
   *                                 requires an explicit local opt-in.
   * @property {boolean} [PaymentMethods] May only disable syncing payment
   *                                      methods (false). A request to enable it
   *                                      is ignored: enabling requires an
   *                                      explicit local opt-in.
   * @property {boolean} [Settings] Whether syncing settings should be enabled
   */

  /**
   * Apply Sync settings
   *
   * @param {EnterprisePoliciesManager} manager
   * @param {SyncPolicyParams} params
   *
   * @returns {Promise<void>} Resolves once all Sync settings have been applied.
   */
  async applySettings(manager, params) {
    lazy.log.debug("Apply Sync Settings");

    const {
      Enabled: shouldEnableSync,
      Locked: isIgnoringUserPreferences,
      ...typeSettings
    } = params;

    if (isIgnoringUserPreferences) {
      // "Tabs from other devices" needs both Sync and its tabs engine unlocked.
      if (shouldEnableSync === false || typeSettings.OpenTabs === false) {
        manager.disallowFeature(SYNC_TABS);
      }

      const isSyncCurrentlyEnabled = this.isSyncCurrentlyEnabled();
      if (shouldEnableSync && !isSyncCurrentlyEnabled) {
        lazy.log.debug("Enable Sync");
        await this.connectSync();
      } else if (shouldEnableSync === false && isSyncCurrentlyEnabled) {
        lazy.log.debug("Disable Sync");
        await this.disconnectSync();
      }
    }

    for (const [type, value] of Object.entries(typeSettings)) {
      const pref = ENGINE_PREFS[type];

      // Passwords and payment methods can only ever be turned off by policy.
      // Enabling them is reserved to an explicit local choice by the user, so a
      // request to turn them on is ignored regardless of `Locked`. Turning them
      // off falls through to the regular handling below.
      if (CONSENT_REQUIRED_ENGINES.has(type) && value !== false) {
        lazy.log.warn(
          `Ignoring policy request to enable ${type} (${pref}); syncing ${type} requires explicit local user consent.`
        );
        continue;
      }

      if (isIgnoringUserPreferences) {
        lazy.log.debug(`Setting and locking ${type}: ${pref} : ${value}`);
        lazy.PoliciesUtils.setAndLockPref(pref, value);
        continue;
      }
      lazy.log.debug(`Setting ${type}: ${pref} : ${value}`);
      lazy.PoliciesUtils.setDefaultPref(pref, value, false);
    }

    // Only lock the Sync feature if 'Enabled' is configured
    if (isIgnoringUserPreferences && shouldEnableSync !== undefined) {
      manager.disallowFeature(SYNC);
    }
  },

  /**
   * Restore initial sync state.
   *
   * @param {EnterprisePoliciesManager} manager
   */
  async restoreSettings(manager) {
    if (!Services.policies.isAllowed(SYNC)) {
      manager.allowFeature(SYNC);
    }
    if (!Services.policies.isAllowed(SYNC_TABS)) {
      manager.allowFeature(SYNC_TABS);
    }
    for (const pref of Object.values(ENGINE_PREFS)) {
      lazy.log.debug(`Unsetting ${pref}`);
      lazy.PoliciesUtils.unsetAndUnlockPref(pref);
    }
    // We don't have a way yet to restore the pre-policy
    // sync state (Bug 2017719)
  },

  /**
   * Disconnect sync
   */
  async disconnectSync() {
    try {
      await lazy.Weave.Service.promiseInitialized;
      await lazy.Weave.Service.startOver();
    } catch (e) {
      lazy.log.error(`Failed to disconnect sync: ${e}`);
    }
  },

  /**
   * Connect sync
   */
  async connectSync() {
    try {
      await lazy.Weave.Service.configure();
    } catch (e) {
      lazy.log.error(`Failed to connect sync: ${e}`);
    }
  },
};
