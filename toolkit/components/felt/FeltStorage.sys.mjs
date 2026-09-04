/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
});

/**
 * Storage helper for reading and writing felt-related profile data to felt.json
 */
export const FeltStorage = {
  _initialized: false,

  _feltStorage: null,
  /**
   * Absolute path to the felt.json file in UAppData.
   *
   * @type {string}
   */
  FELT_FILE_PATH: PathUtils.join(
    Services.dirsvc.get("UAppData", Ci.nsIFile).path,
    "felt.json"
  ),

  async init() {
    if (!this._initialized) {
      this._feltStorage = new lazy.JSONFile({
        path: this.FELT_FILE_PATH,
      });
      this._initialized = true;
    }
    await this._feltStorage.load();
  },

  /**
   * Gets the email that was used to signin the last time (if available)
   *
   * @returns {string | undefined} email
   */
  getLastSignedInUser() {
    return this._feltStorage.data?.lastSignedInUserEmail;
  },

  /**
   * Gets the device ID (generates a ID one if not available)
   *
   * @returns {string} email
   */
  getDeviceId() {
    let id = this._feltStorage.data?.deviceId;
    if (id) {
      return id;
    }
    id = globalThis.crypto.randomUUID();
    this._feltStorage.data.deviceId = id;
    this._feltStorage.saveSoon();
    return id;
  },

  /**
   * Updates the email that was used to sign in the last time
   *
   * @param {string} email
   */
  updateLastSignedInUserEmail(email) {
    if (this._feltStorage.data.lastSignedInUserEmail === email) {
      // Nothing changed.
      return;
    }
    this._feltStorage.data.lastSignedInUserEmail = email;
    this._feltStorage.saveSoon();
  },

  /**
   * Gets the enterprise console address entered in the console setup dialog
   * (if available). Only meaningful on generic builds, where the AutoConfig
   * file does not provide a real address.
   *
   * @returns {string | undefined} url
   */
  getConsoleAddress() {
    return this._feltStorage.data?.consoleAddress;
  },

  /**
   * Persists the enterprise console address, writing felt.json immediately.
   * Called from the pre-profile console setup dialog, which relaunches right
   * after, so the write cannot be deferred to saveSoon().
   *
   * @param {string} url
   */
  async persistConsoleAddress(url) {
    this._feltStorage.data.consoleAddress = url;
    await this._feltStorage._save();
  },

  async uninit() {
    this._feltStorage = {};
    this._initialized = false;
  },
};
