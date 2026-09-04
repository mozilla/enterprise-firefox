/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
});

/**
 * Storage helper for reading and writing felt-related profile data to felt.json
 */
export const FeltStorage = {
  /**
   * Absolute path to the felt.json file in the current profile.
   *
   * @type {string}
   */
  FELT_FILE_PATH: PathUtils.join(
    Services.dirsvc.get("UAppData", Ci.nsIFile).path,
    "felt.json"
  ),

  async init() {
    this._feltStorage = new lazy.JSONFile({
      path: this.FELT_FILE_PATH,
    });
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
   * Whether a locked-session token is stored for the given user. Cheap and
   * synchronous, unlike getLockingToken, so callers that only need to know
   * whether a session can be unlocked should use this.
   *
   * @param {string} email
   * @returns {boolean}
   */
  hasLockingToken(email) {
    return this._feltStorage.data?.lockingTokens?.[email]?.token !== undefined;
  },

  /**
   * Gets and decrypts the stored refresh token for a locked session, if any.
   *
   * @param {string} email
   * @returns {Promise<string | undefined>} The plaintext refresh token, or
   *   undefined if none is stored.
   */
  async getLockingToken(email) {
    const ciphertext = this._feltStorage.data?.lockingTokens?.[email]?.token;
    if (ciphertext === undefined) {
      return undefined;
    }
    return lazy.OSKeyStore.decrypt(ciphertext, "", false);
  },

  /**
   * Returns the user id stored alongside a locked-session token, if any.
   *
   * @param {string} email
   * @returns {string | undefined}
   */
  getLockingUserId(email) {
    return this._feltStorage.data?.lockingTokens?.[email]?.userId;
  },

  /**
   * Encrypts and stores the refresh token for a locked session, plus the user
   * id. Encryption is owned here so a plaintext token can never be persisted to
   * felt.json.
   *
   * @param {string} email
   * @param {string} token The plaintext refresh token.
   * @param {string} [userId] Preserves the existing one if omitted.
   * @returns {Promise<void>}
   */
  async setLockingToken(email, token, userId) {
    const existedBefore = this.hasLockingToken(email);
    const ciphertext = await lazy.OSKeyStore.encrypt(token);
    // A signout may have cleared the record while encrypt() was pending;
    // writing now would resurrect the credential.
    if (existedBefore && !this.hasLockingToken(email)) {
      return;
    }
    if (!this._feltStorage.data.lockingTokens) {
      this._feltStorage.data.lockingTokens = {};
    }
    const record = this._feltStorage.data.lockingTokens[email] ?? {};
    record.token = ciphertext;
    if (userId !== undefined) {
      record.userId = userId;
    }
    this._feltStorage.data.lockingTokens[email] = record;
    this._feltStorage.saveSoon();
  },

  /**
   * Removes any stored locked-session token for the given user.
   *
   * @param {string} email
   */
  clearLockingToken(email) {
    if (this._feltStorage.data.lockingTokens?.[email] !== undefined) {
      delete this._feltStorage.data.lockingTokens[email];
      this._feltStorage.saveSoon();
    }
  },

  async uninit() {
    this._feltStorage = {};
  },
};
