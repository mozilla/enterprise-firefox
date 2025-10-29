/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ConsoleClient takes care of all communication with the remote enterprise console.
 */

export const PREFS = {
  CONSOLE_ADDRESS: "enterprise.console.address",
  // Temporary pref to share refresh token between Felt and Firefox
  REFRESH_TOKEN: "enterprise.console.refresh_token",
};

/**
 * @param {string} [message="Reauthentication required"]
 * @param {string} [reason="UNKNOWN"]
 * @param {{status?: number, cause?: any}} [options]
 */
class ReauthRequiredError extends Error {
  constructor(
    message = "Reauthentication required",
    reason = "UNKNOWN",
    options = { status: null, cause: null }
  ) {
    if (options.cause) {
      super(message, options.cause);
    } else {
      super(message);
    }
    this.name = "ReauthRequiredError";
    this.code = "REAUTH_REQUIRED";
    this.reason = reason;
    if (options.status) {
      this.status = options.status;
    }
  }
}

/**
 *
 */
class InvalidAuthError extends Error {
  constructor(
    message = "Invalid authentication",
    reason = "UNKNOWN",
    options = { cause: null }
  ) {
    if (options.cause) {
      super(message, options.cause);
    } else {
      super(message);
    }
    this.name = "InvalidAuthError";
    this.code = "INVALID_AUTHENTICATION";
    this.reason = reason;
  }
}

/**
 *
 */
class ConsoleTokenData {
  TOKEN_EXPIRY_SKEW = 5 * 60;

  constructor(
    accessToken,
    refreshToken,
    expiresInSec,
    tokenType,
    issuedAtSec = Math.floor(ChromeUtils.now() / 1000)
  ) {
    this._accessToken = accessToken;
    this._refreshToken = refreshToken;
    this._expiresInSec = expiresInSec;
    this._tokenType = tokenType;
    this._issuedAtSec = issuedAtSec;
  }

  get accessToken() {
    return this._accessToken;
  }

  set accessToken(value) {
    this._accessToken = value;
  }

  get refreshToken() {
    return this._refreshToken;
  }

  set refreshToken(value) {
    this._refreshToken = value;
  }

  get expiresInSec() {
    return this._expiresInSec;
  }

  set expiresInSec(value) {
    this._expiresInSec = value;
  }

  get tokenType() {
    return this._tokenType || "Bearer";
  }

  set tokenType(value) {
    this._tokenType = value;
  }

  get issuedAtSec() {
    return this._issuedAtSec;
  }

  set issuedAtSec(value) {
    this._issuedAtSec = value;
  }

  get expiresAtSec() {
    return this._issuedAtSec + this._expiresInSec;
  }

  isExpiringSoon() {
    return (
      Math.floor(ChromeUtils.now() / 1000) + this.TOKEN_EXPIRY_SKEW >=
      (this.expiresAtSec ?? 0)
    );
  }
}

export const ConsoleClient = {
  _refreshPromise: null,

  get refreshTokenBackup() {
    return Services.felt.getRefreshToken();
  },

  get tokenData() {
    return this._tokenData;
  },

  set tokenData(val) {
    this._tokenData = val;
  },

  /**
   * Base url of the enterprise console
   */
  get consoleBaseURI() {
    return new URL(
      Services.prefs.getStringPref(
        PREFS.CONSOLE_ADDRESS,
        "https://console.enterfox.eu"
      )
    );
  },

  get _paths() {
    return {
      SSO: "/sso/login",
      SSO_CALLBACK: "/sso/callback",
      STARTUP_PREFS: "/api/browser/hacks/startup",
      DEFAULT_PREFS: "/api/browser/hacks/default",
      REMOTE_POLICIES: "/api/browser/policies",
      TOKEN: "/sso/token",
    };
  },

  constructURI(path) {
    const url = this.consoleBaseURI;
    url.pathname = path;
    return url.href;
  },

  constructSsoLoginURI(email) {
    const url = this.consoleBaseURI;
    url.pathname = this._paths.SSO;
    url.search = `target=browser&email=${email}`;
    return url.href;
  },

  get ssoCallbackUriMatchPattern() {
    // Dropping the port is required here because the matcher being used by
    // JSActors code relies on WebExtensions MatchPattern
    // https://searchfox.org/firefox-main/source/toolkit/components/extensions/MatchPattern.cpp#370-384
    // The match pattern should then NOT use any port otherwise matching would
    // not happen.
    const url = this.consoleBaseURI;
    url.pathname = this._paths.SSO_CALLBACK;
    url.port = "";
    return url.href + "?*";
  },

  // prefs that needs to be read at startup, i.e., written to profile's prefs.js
  // tbd: remove
  async getStartupPrefs() {
    const payload = await this._get(this._paths.STARTUP_PREFS);
    return payload;
  },

  // prefs that do not need to be written and can be sent during runtime
  // tbd: remove
  async getDefaultPrefs() {
    const payload = await this._get(this._paths.DEFAULT_PREFS);
    return payload;
  },

  /**
   * Fetched remote enterprise policies.
   *
   * @returns {object} { policies: { ... } }
   */
  async getRemotePolicies() {
    const payload = await this._get(this._paths.REMOTE_POLICIES);
    return payload;
  },

  /**
   * Ensures that we have a valid session and performs an authenticated fetch against
   * a registered console endpoint. If we get a 401 or 403 refresh and retry to fetch once.
   *
   * @param {string} path
   * @param {object} options
   * @param {bool} options._didRefresh
   * @throws {InvalidAuthError|Error}
   * @returns {Promise<any>}
   */
  async _get(path, { _didRefresh = false } = {}) {
    await this._ensureValidSession();

    const headers = new Headers({});
    const { tokenType, accessToken } = this.tokenData;
    headers.set("Authorization", `${tokenType} ${accessToken}`);

    const url = this.constructURI(path);
    const res = await fetch(url, { headers });

    if (res.ok) {
      return await res.json();
    }

    if ((res.status === 403 || res.status === 401) && !_didRefresh) {
      await this._refreshSession();
      return this._get(path, { _didRefresh: true });
    }

    const text = await res.text().catch(() => "");
    throw new Error(`Fetch failed (${res.status}): ${text}`);
  },

  /**
   * Ensures a non-expired access token is available,
   * refreshing if it is expiring soon.
   */
  async _ensureValidSession() {
    const td = this.tokenData;
    if (!td?.accessToken || td.isExpiringSoon()) {
      await this._refreshSession();
    }
  },

  /**
   * Refreshes the session using a refresh token.
   * Uses the provided token if given; otherwise the stored token.
   * Serializes concurrent refreshes via an internal promise.
   *
   * @throws {ReauthRequiredError|InvalidAuthError} If unable to refresh token
   * @returns {Promise<void>}
   */
  async _refreshSession() {
    if (this._refreshPromise) {
      return this._refreshPromise;
    }

    this._refreshPromise = (async () => {
      let refreshToken =
        this.tokenData?.refreshToken || this.refreshTokenBackup;
      if (!refreshToken) {
        this.clearTokenData();
        const e = new ReauthRequiredError(
          "No refresh token available",
          "MISSING_REFRESH_TOKEN"
        );
        console.error(e);
        await this.promptForReauthentication();
        return;
      }
      try {
        const url = this.constructURI(this._paths.TOKEN);
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }),
        });

        if (res.status === 401 || res.status === 403) {
          const e = new ReauthRequiredError(
            "Invalid refresh token",
            "INVALID_REFRESH_TOKEN",
            { status: res.status }
          );
          console.error(e);
          await this.promptForReauthentication();
          return;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new InvalidAuthError(
            `Token refresh failed (${res.status}): ${text}`,
            "REFRESH_FAILED"
          );
          // TODO: Handle network issues, offline support, etc.
        }

        const t = await res.json();
        this.ensureTokenData(t);

        Services.prefs.setStringPref(
          PREFS.REFRESH_TOKEN,
          this.tokenData.refreshToken
        );
      } catch (e) {
        throw new InvalidAuthError(
          e?.message || "Fatal! Token refresh failed",
          "TOKEN_REFRESH_FAILED",
          { cause: e }
        );
      } finally {
        this._refreshPromise = null;
      }
    })();

    return this._refreshPromise;
  },

  /**
   * If we refresh token expired or no valid session can be found
   * we prompt for reauthentication to obtain a valid set of access
   * and refresh token.
   */
  async promptForReauthentication() {
    this.clearTokenData();
    // TODO: Handle Re-authentication
  },

  /**
   * Populates in-memory token state at the moment that we receive the
   * token data on initial authentication with the console.
   *
   * @param {object} tokenData { access_token, refresh_token, expires_in, token_type }
   */
  ensureTokenData(tokenData) {
    const { access_token, refresh_token, expires_in, token_type } = tokenData;
    Services.felt.setTokens(access_token, refresh_token);
    this.tokenData = new ConsoleTokenData(
      access_token,
      refresh_token,
      expires_in,
      token_type
    );
  },

  /**
   * Clears persisted and in-memory token data, which
   * only exists in Firefox, not in Felt.
   */
  clearTokenData() {
    Services.felt.setRefreshToken("");
  },

  uninit() {
    this.clearTokenData();
    this._refreshPromise = null;
  },
};
