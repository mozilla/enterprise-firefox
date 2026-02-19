/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  PREF_LOGLEVEL,
  setAndLockPref,
  unsetAndUnlockPref,
  PoliciesUtils,
} from "resource:///modules/policies/Policies.sys.mjs";

import { STATUS_OK as SYNC_STATUS_OK } from "resource://services-sync/constants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
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

const SYNC_FEATURE = "change-sync-state";

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
  isSyncEnabled() {
    return lazy.Weave.Status.checkSetup() == SYNC_STATUS_OK;
  },

  /**
   * @typedef {object} SyncPolicyParams
   * @property {boolean} [Enabled] Whether Sync should be enabled
   * @property {boolean} [addresses] Whether syncing addresses should be enabled
   * @property {boolean} [bookmarks] Whether syncing bookmarks should be enabled
   * @property {boolean} [history] Whether syncing history should be enabled
   * @property {boolean} [openTabs] Whether syncing openTabs should be enabled
   * @property {boolean} [passwords] Whether syncing passwords should be enabled
   * @property {boolean} [paymentMethods] Whether syncing paymentMethods should be enabled
   * @property {boolean} [addons] Whether syncing addons should be enabled
   * @property {boolean} [settings] Whether syncing settings should be enabled
   * @property {boolean} [Locked] Whether to lock the customized sync settings
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

    // This might be an update to the Sync policy
    // so restore previous sync settings
    this.restoreSettings(manager);

    const {
      Enabled: shouldEnableSync,
      Locked: shouldLock,
      ...typeSettings
    } = params;

    const isSyncEnabled = this.isSyncEnabled();

    if (shouldEnableSync === true) {
      lazy.log.debug("Enable Sync");
      if (!isSyncEnabled) {
        await this.connectSync(manager);
      }
    } else if (shouldEnableSync === false) {
      lazy.log.debug("Disable Sync");
      if (isSyncEnabled) {
        await this.disconnectSync(manager);
      }
    }

    for (const [type, value] of Object.entries(typeSettings)) {
      const pref = ENGINE_PREFS[type];
      if (shouldLock) {
        lazy.log.debug(`Setting and locking ${type}: ${pref} : ${value}`);
        setAndLockPref(pref, value);
        continue;
      }
      lazy.log.debug(`Setting ${type}: ${pref} : ${value}`);
      PoliciesUtils.setDefaultPref(pref, value, false);
    }

    // Only lock the Sync feature if 'Enabled' is configured
    if (shouldLock && shouldEnableSync !== undefined) {
      manager.disallowFeature(SYNC_FEATURE);
    }
  },

  /**
   * Restore initial sync state.
   *
   * @param {EnterprisePoliciesManager} manager
   */
  async restoreSettings(manager) {
    if (!Services.policies.isAllowed(SYNC_FEATURE)) {
      manager.allowFeature(SYNC_FEATURE);
    }
    for (const pref of Object.values(ENGINE_PREFS)) {
      lazy.log.debug(`Unsetting ${pref}`);
      unsetAndUnlockPref(pref);
    }

    // We don't have a way yet to restore the pre-policy sync
    // state (Bug 2017719). So for now we fallback to sync enabled.
    this.connectSync();
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
