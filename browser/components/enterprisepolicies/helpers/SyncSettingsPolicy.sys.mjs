/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PREF_LOGLEVEL: "resource:///modules/policies/Policies.sys.mjs",
  setAndLockPref: "resource:///modules/policies/Policies.sys.mjs",
  STATUS_OK: "resource://services-sync/constants.sys.mjs",
  unsetAndUnlockPref: "resource:///modules/policies/Policies.sys.mjs",
  Weave: "resource://services-sync/main.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return console.createInstance({
    prefix: "SyncSettingsPolicy",
    maxLogLevelPref: lazy.PREF_LOGLEVEL,
  });
});

const ENGINE_PREFS = {
  addresses: "services.sync.engine.addresses",
  addons: "services.sync.engine.addons",
  bookmarks: "services.sync.engine.bookmarks",
  history: "services.sync.engine.history",
  openTabs: "services.sync.engine.tabs",
  passwords: "services.sync.engine.passwords",
  paymentMethods: "services.sync.engine.creditcards",
  settings: "services.sync.engine.prefs",
};

const STATE = {
  DEFAULT: "default",
  SYNC_ENABLED: "enabled",
  SYNC_DISABLED: "disabled",
  POLICY_NOT_APPLIED: "policy-not-applied",
};

/**
 * Policy to control the Sync state (force-enable or force-disable Sync)
 * and to control which data types are synced. The user is not able to
 * customize Sync settings when this policy is active.
 */
export const SyncSettingsPolicy = {
  _isSyncEnabledDefaultValue: null,
  _currentPolicyState: null,

  /**
   * Get current sync state.
   *
   * @returns {boolean} Whether sync is currently enabled.
   */
  isSyncEnabled() {
    return lazy.Weave.Status.checkSetup() == lazy.STATUS_OK;
  },

  /**
   * @typedef {object} SyncSettings
   * @property {boolean} SyncEnabled Whether Sync should be force-enabled or force-disabled.
   * @property {Array<"addresses"|"bookmarks"|"history"|"openTabs"|"passwords"|"paymentMethods"|"addons"|"settings">} TypesEnabled
   *   Which data types should be synced when Sync is force-enabled.
   */

  /**
   * Apply policy Sync settings to the current profile and prevent changes to
   * the Sync state while the policy is active.
   *
   * @param {EnterprisePoliciesManager} manager
   * @param {SyncSettings} param
   *
   * @returns {Promise<void>} Resolves once all Sync settings have been applied.
   */
  async applySettings(manager, param) {
    lazy.log.debug("Apply Sync Settings");

    const isSyncEnabled = this.isSyncEnabled();
    if (this._isSyncEnabledDefaultValue === null) {
      // Cache initial sync state
      this._isSyncEnabledDefaultValue = isSyncEnabled;
    }

    if (!param.SyncEnabled) {
      lazy.log.debug("Force-disable Sync");
      if (isSyncEnabled) {
        await this.disconnectSync(manager);
      }
      return;
    }

    lazy.log.debug("Force-enable Sync");

    for (const [type, pref] of Object.entries(ENGINE_PREFS)) {
      if (param.TypesEnabled.includes(type)) {
        lazy.log.debug(`Enabling type: ${type}`);
        lazy.setAndLockPref(pref, true);
      } else {
        lazy.log.debug(`Disabling type: ${type}`);
        lazy.setAndLockPref(pref, false);
      }
    }

    await this.connectSync(manager);

    this._currentPolicyState = STATE.SYNC_ENABLED;
  },

  /**
   * Restore Sync preferences and state to what they were before policy enforcement,
   * and re-allow changes to the Sync state.
   *
   * @param {EnterprisePoliciesManager} manager
   */
  async restoreSettings(manager) {
    lazy.log.debug("Restore Sync Settings");

    if (this._currentPolicyState !== STATE.DEFAULT) {
      // Only restore the default state if the current state
      // isn't already the default state.
      this.restoreDefault(manager);
    }

    this._currentPolicyState = STATE.POLICY_NOT_APPLIED;
  },

  /**
   * Restore default state
   *
   * @param {EnterprisePoliciesManager} manager
   */
  async restoreDefault(manager) {
    for (const pref of Object.values(ENGINE_PREFS)) {
      lazy.unsetAndUnlockPref(pref);
    }

    const isSyncEnabled = this.isSyncEnabled();

    if (this._isSyncEnabledDefaultValue) {
      // Re-connecting to re-trigger a Sync action with the
      // restored default enabled types.
      lazy.log.debug("Restoring Sync state by enabling it.");
      await this.connectSync(manager);
    } else if (!this._isSyncEnabledDefaultValue && isSyncEnabled) {
      lazy.log.debug("Restoring Sync state by disabling it.");
      await this.disconnectSync(manager);
    }

    this._isSyncEnabledDefaultValue = null;
    manager.allowFeature("change-sync-state");
  },

  /**
   * Disconnect Sync and disallow any changes to the sync state.
   *
   * @param {EnterprisePoliciesManager} manager
   */
  async disconnectSync(manager) {
    manager.allowFeature("change-sync-state");
    await lazy.Weave.Service.promiseInitialized;
    await lazy.Weave.Service.startOver();
    manager.disallowFeature("change-sync-state");
  },

  /**
   * Connect Sync and disallow any changes to the sync state.
   *
   * @param {EnterprisePoliciesManager} manager
   */
  async connectSync(manager) {
    manager.allowFeature("change-sync-state");
    await lazy.Weave.Service.configure();
    manager.disallowFeature("change-sync-state");
  },
};
