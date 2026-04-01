/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient: "resource:///modules/enterprise/ConsoleClient.sys.mjs",
  EnterpriseCommon: "resource:///modules/enterprise/EnterpriseCommon.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return console.createInstance({
    prefix: "EnterpriseAccountStorage",
    maxLogLevelPref: lazy.EnterpriseCommon.ENTERPRISE_LOGLEVEL_PREF,
  });
});

/**
 * EnterpriseStorageManager maintains and updates the FxA and Sync account data.
 *
 * Its implementation is mirroring the one from FxAccountsStorage, hence it surfaces the same
 * APIs that are necessary to sign the user into FxA and to enable Sync.
 * Unlike FxAccountsStorage, which reads the storage data from the profile, EnterpriseStorageManager
 * requests the required data once from the console and stores and udpates it in memory only.
 */
export class EnterpriseStorageManager {
  #getAccountDataPromise = Promise.reject(
    "EnterpriseStorageManager: Initialize not called"
  );

  /**
   * Initialize the storage by fetching account data from the remote console.
   * This method swaps the internal #getAccountDataPromise with the promise
   * returned by lazy.ConsoleClient.getFxAccountData().
   * Callers need to call initialize before invoking getAccountData() or updateAccountData().
   *
   * @param {object} _ - Not used. Only kept for API parity.
   */
  initialize(_) {
    lazy.log.debug("Initializing the storage.");
    // If we just throw away our pre-rejected promise it is reported as an
    // unhandled exception when it is GCd - so add an empty .catch handler here
    // to prevent this.
    this.#getAccountDataPromise.catch(() => {});
    this.#getAccountDataPromise = Services.felt.isFeltUI()
      ? Promise.resolve(null) // Felt has no signed-in user on startup; avoid guaranteed 401 from FxA
      : lazy.ConsoleClient.getFxAccountData();
  }

  /**
   * Does nothing. Only kept for API parity.
   */
  finalize() {}

  /**
   * Retrieve account data (or a subset of fields) from the cached console data.
   *
   * @param {Array<string>|string} [fieldNames=null]
   *
   * @returns {Promise<object|null>} Promise which resolves to the cached account data.
   */
  async getAccountData(fieldNames = null) {
    const data = await this.#getAccountDataPromise;

    if (fieldNames) {
      if (!Array.isArray(fieldNames)) {
        fieldNames = [fieldNames];
      }

      const subset = {};
      for (const name of fieldNames) {
        subset[name] = data[name];
      }
      return structuredClone(subset);
    }
    return structuredClone(data);
  }

  /**
   * Update the cached account data object and replace the cached promise with
   * another resolved promise containing the modified account data.
   *
   * @param {object} newFields - fields that need to be updated in the cache.
   *
   * @throws {Error} If no user is logged in or if caller tries to change uid.
   *
   * @returns {Promise<void>} Promise resolving once the in-memory cache is updated
   */
  async updateAccountData(newFields) {
    const data = await this.#getAccountDataPromise;
    if (!("uid" in data)) {
      // If there is no logged-in user, we cannot update fields.
      throw new Error("No user is logged in");
    }

    if (!newFields || "uid" in newFields) {
      // Prevent callers from changing uid.
      throw new Error("Can't change uid");
    }

    lazy.log.debug("_updateAccountData with items", Object.keys(newFields));

    for (let [name, value] of Object.entries(newFields)) {
      if (value == null) {
        delete data[name];
      } else {
        data[name] = value;
        if (name === "device") {
          // Keep track of the latest device id in the prefs.
          // It's used by the ConsoleClient to communicate
          // the device id to the console.
          const deviceId = data[name]?.id;
          if (deviceId) {
            Services.prefs.setStringPref(
              lazy.EnterpriseCommon.ENTERPRISE_DEVICE_ID_PREF,
              deviceId
            );
          }
        }
      }
    }
    this.#getAccountDataPromise = Promise.resolve(data);
  }

  /**
   * Clear current account data. By replacing the cached promise with a
   * rejected one we restore the initial uninitialized behavior.
   */
  deleteAccountData() {
    this.#getAccountDataPromise = Promise.reject(
      "EnterpriseStorageManager: Initialize not called"
    );
  }
}
