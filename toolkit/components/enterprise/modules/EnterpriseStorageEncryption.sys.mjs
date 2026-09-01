/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
});

export const EnterpriseStorageEncryption = {
  async init() {
    if (
      Services.prefs.getBoolPref(
        "security.storage.encryption.enabled",
        false
      ) &&
      Services.felt?.isFeltBrowser()
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
      }
    } catch (e) {
      fail("SDR login failed", e);
    }
  },
};
