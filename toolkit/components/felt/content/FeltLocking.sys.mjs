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

export const FeltLocking = {
  /**
   * Attempt to resume a previously locked session for the given user. Requires
   * OS-level authentication and a stored, still-valid refresh token.
   *
   * @param {string} rawEmail
   * @param {Element} browser
   * @returns {Promise<boolean>} Whether the session was successfully unlocked.
   */
  tryUnlock: async (rawEmail, browser) => {
    const email = rawEmail.trim();

    // A stored token exists only because a browser-authorized lock created it,
    // so its presence is the authorization to resume: the locking pref lives in
    // the browser process, which the Felt UI process cannot read.
    if (lazy.FeltStorage.hasLockingToken(email)) {
      const [messageText, captionText] = await lazy.localization.formatValues([
        "felt-sso-unlock-os-auth-dialog-message",
        "felt-sso-unlock-os-auth-dialog-caption",
      ]);
      const { authenticated } = await lazy.OSKeyStore.ensureLoggedIn(
        messageText,
        captionText
      );

      if (authenticated) {
        // Decrypt only after OS auth succeeds, so authentication gates access
        // to the token rather than merely gating the resume that follows.
        let lockingToken, tokenData;
        try {
          lockingToken = await lazy.FeltStorage.getLockingToken(email);
        } catch (err) {
          lazy.log.warn(
            `tryUnlock: decrypt failed, falling back to sign-in: ${err}`
          );
        }
        if (!lockingToken) {
          Services.felt.setTokens("", "", 0);
          lazy.FeltStorage.clearLockingToken(email);
          return false;
        }
        // Only the refresh token is available here; force a refresh below.
        Services.felt.setTokens("", lockingToken, 0);
        try {
          tokenData = await lazy.ConsoleClient.refreshTokens();

          // refreshTokens has already committed the rotated pair, so failing
          // to persist it must not tear the working session down. The stored
          // copy stays stale until the next rotation syncs it.
          await lazy.FeltStorage.setLockingToken(
            email,
            tokenData.refresh_token
          ).catch(err =>
            lazy.log.warn(`tryUnlock: failed to persist rotated token: ${err}`)
          );
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
        const userId = lazy.FeltStorage.getLockingUserId(email);
        const parentActor =
          browser.browsingContext.currentWindowGlobal.domProcess.getActor(
            "FeltProcess"
          );
        await parentActor.receiveMessage({
          name: "FeltChild:StartFirefox",
          data: { ...tokenData, isUnlock: true, user_id: userId, email },
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
   * @param {string} userId The user id, stored so the unlock can resume into
   *   the same per-user profile.
   * @throws {Error} If no signed-in user, refresh token, or user id is known,
   *   so the caller can fall back to signing out instead of persisting a record
   *   that cannot resume a session.
   * @returns {Promise<void>}
   */
  store: async (refresh_token, userId) => {
    const email = lazy.FeltStorage.getLastSignedInUser();
    if (!email) {
      throw new Error(
        "store: no signed-in user known, cannot persist locked session"
      );
    }
    if (!refresh_token || !userId) {
      throw new Error(
        "store: missing refresh token or user id, cannot persist locked session"
      );
    }
    await lazy.FeltStorage.setLockingToken(email, refresh_token, userId);
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
    const email = lazy.FeltStorage.getLastSignedInUser();
    if (!email || !lazy.FeltStorage.hasLockingToken(email)) {
      return;
    }
    await lazy.FeltStorage.setLockingToken(email, refresh_token);
  },

  /**
   * Remove any stored locked-session token for the current user. Always runs
   * (even when locking is disabled) so signing out can never leave a credential
   * behind. No-op when no user is known or nothing is stored.
   *
   * @returns {void}
   */
  clear: () => {
    const email = lazy.FeltStorage.getLastSignedInUser();
    if (!email) {
      return;
    }
    lazy.FeltStorage.clearLockingToken(email);
  },
};
