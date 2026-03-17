const ENTERPRISE_LOCKING_TOKENS_PREF = "enterprise.locking.tokens";
const ENTERPRISE_LOCKING_ENABLED_PREF = "enterprise.locking.enabled";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient: "resource:///modules/enterprise/ConsoleClient.sys.mjs",
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
});

function lockingEnabled() {
  return Services.prefs.getBoolPref(ENTERPRISE_LOCKING_ENABLED_PREF, false);
}

async function updateTokensPref(tokens, email, token) {
  if (token) {
    const encryptedUpdatedRefreshToken = await lazy.OSKeyStore.encrypt(
      token,
      "",
      false
    );
    tokens[email] = encryptedUpdatedRefreshToken;
  } else {
    delete tokens[email];
  }
  Services.prefs.setStringPref(
    ENTERPRISE_LOCKING_TOKENS_PREF,
    JSON.stringify(tokens)
  );
}

function getTokens() {
  const tokensString = Services.prefs.getStringPref(
    ENTERPRISE_LOCKING_TOKENS_PREF,
    "{}"
  );
  let tokens;
  try {
    tokens = JSON.parse(tokensString);
  } catch {
    console.warn(`FeltLocking: unable to parse tokens from pref`);
    tokens = {};
  }
  return tokens;
}

export const FeltLocking = {
  /**
   *
   * @param {string} email
   * @param {Element} browser
   * @returns {boolean}
   */
  tryUnlock: async (email, browser) => {
    if (lockingEnabled()) {
      const tokens = getTokens();
      const token = tokens?.[email];
      if (token) {
        const { authenticated } = await lazy.OSKeyStore.ensureLoggedIn(
          "Trying to unlock existing session",
          "Firefox Enterprise"
        );
        if (authenticated) {
          const refreshToken = await lazy.OSKeyStore.decrypt(token, "", false);
          // Only set the refresh token since that's all we have.
          Services.felt.setTokens("", refreshToken, 0);
          try {
            // Get an access token to force a refresh.
            await lazy.ConsoleClient.getAccessToken();

            const updatedRefreshToken = Services.felt.getRefreshToken();
            await updateTokensPref(tokens, email, updatedRefreshToken);

            const parentActor =
              browser.browsingContext.currentWindowGlobal.domProcess.getActor(
                "FeltProcess"
              );
            parentActor.receiveMessage({
              name: "FeltChild:StartFirefox",
              data: {},
            });
            return true;
          } catch (err) {
            console.debug(`FeltExtension: Error resuming from token: {err}`);
            await updateTokensPref(tokens, email, null);
          }
        }
      }
    }
    return false;
  },

  store: async refresh_token => {
    if (lockingEnabled()) {
      const tokens = getTokens();
      let { email } = await lazy.ConsoleClient.getLoggedInUserInfo();

      await updateTokensPref(tokens, email, refresh_token);
    }
  },
};
