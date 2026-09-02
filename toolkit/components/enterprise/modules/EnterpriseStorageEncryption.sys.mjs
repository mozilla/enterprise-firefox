/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
});

const PROFILE_ENCRYPTION_KEK_ID = "profileEncryption";
const PROFILE_ENCRYPTION_KEK_REF = `lockstore::kek::password:${PROFILE_ENCRYPTION_KEK_ID}`;
// Lockstore treats 0 as "don't cache" and clamps large values, so this is
// effectively "unlocked for the whole session".
const KEK_CACHE_TIMEOUT_MS = 2 ** 32;

export const EnterpriseStorageEncryption = {
  get PROFILE_ENCRYPTION_KEK_REF() {
    return PROFILE_ENCRYPTION_KEK_REF;
  },

  async init() {
    if (
      AppConstants.MOZ_ENTERPRISE &&
      Services.prefs.getBoolPref(
        "security.storage.encryption.enabled",
        false
      ) &&
      !Services.felt?.isFeltUI()
    ) {
      await this.load();
    }
  },

  async load() {
    // A managed browser that cannot unlock its encrypted storage must not
    // keep running: it would prompt for a primary secret the user does not
    // know, or operate against a profile it cannot decrypt. Fail the launch
    // with a dedicated exit code (Bug 2021342), mirroring the launcher-side
    // abort in FeltProcessParent.
    const fail = (msg, e) => {
      console.error(
        `EnterpriseStorageEncryption.load: ${msg}${e ? ": " + e : ""}`
      );
      Services.startup.quit(
        Ci.nsIAppStartup.eForceQuit,
        Ci.nsIFelt.FeltEncryptionExitCode_SdrTokenUnlockFailed
      );
    };

    // The API returns { data: "secret_value" }.
    let primarySecret;
    try {
      primarySecret = (await lazy.ConsoleClient.getPrimarySecret()).data;
    } catch (e) {
      fail("Failed to get primary secret", e);
      return;
    }
    if (!primarySecret) {
      fail("No primary secret in payload");
      return;
    }

    let pk11token;
    try {
      pk11token = Cc["@mozilla.org/security/internalkeytoken;1"].createInstance(
        Ci.nsIPKCS11Token
      );
    } catch (e) {
      fail("Error getting PK11 token", e);
      return;
    }

    // Ensure the internal token's password is the primarySecret.
    if (!pk11token.hasPassword) {
      try {
        await pk11token.changePassword("", primarySecret);
      } catch (e) {
        fail("Failed to set the primary secret on the token", e);
        return;
      }
    }

    // changePassword does not authenticate the session, so log in
    // explicitly and verify.
    try {
      const sdr = Cc["@mozilla.org/security/sdr;1"].getService(
        Ci.nsISecretDecoderRing
      );
      if (!sdr.login(primarySecret) || !pk11token.isLoggedIn) {
        fail("Internal token not logged in after unlock");
        return;
      }
    } catch (e) {
      fail("SDR login failed", e);
      return;
    }

    try {
      await this.ensureProfileEncryptionKek(primarySecret);
    } catch (e) {
      fail("Failed to unlock the profileEncryption KEK", e);
    }
  },

  /**
   * Unlock-or-create the `lockstore::kek::password:profileEncryption` KEK
   * keyed by the console primarySecret, leaving it unlocked for the session.
   *
   * @param {string} primarySecret
   * @returns {Promise<string>} the kekRef
   */
  async ensureProfileEncryptionKek(primarySecret) {
    const lockstore = Cc["@mozilla.org/security/lockstore;1"].getService(
      Ci.nsILockstore
    );
    try {
      await lockstore.unlockKek(
        PROFILE_ENCRYPTION_KEK_REF,
        primarySecret,
        KEK_CACHE_TIMEOUT_MS
      );
      return PROFILE_ENCRYPTION_KEK_REF;
    } catch (e) {
      // NOT_AVAILABLE / INVALID_ARG mean the KEK does not exist yet; anything
      // else (notably NS_ERROR_ABORT on a wrong secret) is a real failure.
      if (
        e.result !== Cr.NS_ERROR_NOT_AVAILABLE &&
        e.result !== Cr.NS_ERROR_INVALID_ARG
      ) {
        throw e;
      }
    }
    // createKek with a fixed identifier is get-or-create and, for a fresh
    // Password KEK, also caches it for cacheTimeoutMs.
    return lockstore.createKek(
      "password",
      PROFILE_ENCRYPTION_KEK_ID,
      primarySecret,
      KEK_CACHE_TIMEOUT_MS
    );
  },
};
