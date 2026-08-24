/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  FeltStorage: "resource://gre/modules/enterprise/FeltStorage.sys.mjs",
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("FeltLocking");
});

ChromeUtils.defineLazyGetter(lazy, "localization", () => {
  return new Localization(
    ["toolkit/enterprise/felt.ftl", "branding/brand.ftl"],
    true
  );
});


/**
 * The email of the currently signed-in user, used as the key under which a
 * locked session's refresh token is stored. Read from the cached value rather
 * than the network so locking cannot hang or fail at shutdown.
 *
 * @returns {string | undefined} email
 */
function currentEmail() {
  return lazy.FeltStorage.getLastSignedInUser();
}

/**
 * Encrypts the refresh token and persists it for the given user via
 * FeltStorage, so the value never lands in a plaintext pref / about:config.
 *
 * @param {string} email
 * @param {string} token The plaintext refresh token.
 * @returns {Promise<void>}
 */
async function storeToken(email, token) {
  const encryptedRefreshToken = await lazy.OSKeyStore.encrypt(token);
  lazy.FeltStorage.setLockingToken(email, encryptedRefreshToken);
}

export const FeltLocking = {
  /**
   * Attempt to resume a previously locked session for the given user. Requires
   * OS-level authentication and a stored, still-valid refresh token.
   *
   * @param {string} email
   * @param {Element} browser
   * @returns {Promise<boolean>} Whether the session was successfully unlocked.
   */
  tryUnlock: async (email, browser) => {
    // A stored token exists only because a browser-authorized lock created it,
    // so its presence is the authorization to resume: the locking pref lives in
    // the browser process, which the Felt UI process cannot read.
    const token = lazy.FeltStorage.getLockingToken(email);
    if (token) {
      const [ messageText, captionText ] = await lazy.localization.formatValues([
        "felt-sso-unlock-os-auth-dialog-message",
        "felt-sso-unlock-os-auth-dialog-caption"
      ]);
      const { authenticated } = await lazy.OSKeyStore.ensureLoggedIn(
        messageText,
        captionText
      );
      if (authenticated) {
        let refreshToken;
        try {
          refreshToken = await lazy.OSKeyStore.decrypt(token, "", false);
        } catch (err) {
          lazy.log.warn(
            `tryUnlock: decrypt failed, falling back to sign-in: ${err}`
          );
        }
        if (!refreshToken) {
          Services.felt.setTokens("", "", 0);
          lazy.FeltStorage.clearLockingToken(email);
          return false;
        }
        // Only the refresh token is available here; force a refresh below.
        Services.felt.setTokens("", refreshToken, 0);
        try {
          const { access_token, refresh_token, expires_at } =
            await lazy.ConsoleClient.refreshTokens();
          Services.felt.setTokens(access_token, refresh_token, expires_at);

          await storeToken(email, refresh_token);
        } catch (err) {
          Services.felt.setTokens("", "", 0);
          if (err?.name === "ReauthRequiredError") {
            // The refresh token is genuinely invalid/revoked: drop it so we
            // fall back to a full SSO sign-in.
            lazy.FeltStorage.clearLockingToken(email);
          } else {
            // Transient failure (offline, server error, ...): keep the stored
            // token so the session can still be unlocked later.
            lazy.log.warn(
              `tryUnlock: transient failure resuming from token, keeping it: ${err}`
            );
          }
          return false;
        }

        // Tokens are committed; from here a failure is a launch failure, not
        // a reason to fall back to SSO, so let it propagate to the caller.
        const parentActor =
          browser.browsingContext.currentWindowGlobal.domProcess.getActor(
            "FeltProcess"
          );
        await parentActor.receiveMessage({
          name: "FeltChild:StartFirefox",
          data: {},
        });
        return true;
      }
    }
    return false;
  },

  /**
   * Persist the (encrypted) refresh token so the session can later be unlocked.
   * Only ever reached via an explicit, browser-authorized lock, so it does not
   * consult the locking pref (which the Felt UI process cannot read).
   *
   * @param {string} refresh_token
   * @throws {Error} If no signed-in user is known, so the caller can fall back
   *   to signing out instead of locking.
   * @returns {Promise<void>}
   */
  store: async refresh_token => {
    const email = currentEmail();
    if (!email) {
      throw new Error(
        "store: no signed-in user known, cannot persist locked session"
      );
    }
    await storeToken(email, refresh_token);
  },

  /**
   * Keep an already-persisted token in sync with a rotated refresh token. Never
   * creates one: persistence is authorized only by an explicit lock, so a token
   * refresh must not turn a non-locking session into a lockable one.
   *
   * @param {string} refresh_token
   * @returns {Promise<void>}
   */
  updateStoredToken: async refresh_token => {
    const email = currentEmail();
    if (!email || !lazy.FeltStorage.getLockingToken(email)) {
      return;
    }
    await storeToken(email, refresh_token);
  },

  /**
   * Remove any stored locked-session token for the current user. Always runs
   * (even when locking is disabled) so signing out can never leave a credential
   * behind. No-op when no user is known or nothing is stored.
   *
   * @returns {void}
   */
  clear: () => {
    const email = currentEmail();
    if (!email) {
      return;
    }
    lazy.FeltStorage.clearLockingToken(email);
  },
};
