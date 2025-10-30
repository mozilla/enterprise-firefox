/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ConsoleClient takes care of all communication with the remote enterprise console.
 */

/**
 * Preferences used to integrate the a remote enterprise console
 */
export const PREFS = {
  CONSOLE_ADDRESS: "enterprise.console.address",
  // Temporary pref to share refresh token between Felt and Firefox
  REFRESH_TOKEN: "enterprise.console.refresh_token",
};

/**
 * Error logged when user needs to reauthenticate to obtain new token data
 */
class ReauthRequiredError extends Error {
  /**
   * @param {string} [message="Reauthentication required"]
   * @param {"MISSING_REFRESH_TOKEN"|"INVALID_REFRESH_TOKEN"|"UNKNOWN"} [reason="UNKNOWN"]
   * @param {{status?: number|null, cause?: any}} [options]
   */
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
 * Error thrown when authentication is present but invalid for the requested operation.
 */
class InvalidAuthError extends Error {
  /**
   * @param {string} [message="Invalid authentication"]
   * @param {"TOKEN_REFRESH_FAILED"|"UNKNOWN"} [reason="UNKNOWN"]
   * @param {{cause?: any}} [options]
   */
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
 * Structured token data associated with the console session.
 * Encapsulates expiry/refresh logic and provides helpers for access token validity.
 */
class ConsoleTokenData {
  /**
   * Seconds of skew subtracted from expiry to proactively refresh early.
   *
   * @type {number}
   */
  TOKEN_EXPIRY_SKEW = 5 * 60;

  /**
   * @param {string} accessToken - Short-lived access token.
   * @param {string} refreshToken - Long-lived refresh token.
   * @param {number} expiresInSec - Access token lifetime (in seconds) from issuance.
   * @param {string} [tokenType="Bearer"] - Token type
   * @param {number} [issuedAtSec=Math.floor(ChromeUtils.now()/1000)] - Monotonic issued-at time in seconds
   */
  constructor(
    accessToken,
    refreshToken,
    expiresInSec,
    tokenType = "Bearer",
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
    return this._tokenType;
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

  /**
   * Whether the access token is expired or will expire soon.
   *
   * @returns {boolean}
   */
  isExpiringSoon() {
    return (
      Math.floor(ChromeUtils.now() / 1000) + this.TOKEN_EXPIRY_SKEW >=
      (this.expiresAtSec ?? 0)
    );
  }
}

/**
 * Client for interacting with the Enterprise Console API.
 * Manages token state and provides helper methods for common endpoints.
 */
export const ConsoleClient = {
  _refreshPromise: null,

  /**
   * Returns the refresh token (if any), that Felt stored in the prefs.
   *
   * @returns {string}
   */
  get refreshTokenBackup() {
    return Services.prefs.getStringPref(PREFS.REFRESH_TOKEN, "");
  },

  /**
   * In-memory token data for the active session.
   *
   * @returns {ConsoleTokenData|undefined}
   */
  get tokenData() {
    return this._tokenData;
  },

  set tokenData(data) {
    this._tokenData = data;
  },

  /**
   * Base URL of the remote enterprise console
   *
   * @returns {URL}
   */
  get consoleBaseURI() {
    return new URL(
      Services.prefs.getStringPref(
        PREFS.CONSOLE_ADDRESS,
        "https://console.enterfox.eu"
      )
    );
  },

  /**
   * Paths to API endpoints of the remote enterprise console
   */
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

  /**
   * Constructs an absolute URL for a console API path.
   *
   * @param {string} path
   * @returns {string} Absolute URL string.
   */
  constructURI(path) {
    const url = this.consoleBaseURI;
    url.pathname = path;
    return url.href;
  },

  /**
   * Constructs the SSO login URL for the provided email.
   *
   * @param {string} email - Email address to prefill for SSO initiation.
   * @returns {string}
   */
  constructSsoLoginURI(email) {
    const url = this.consoleBaseURI;
    url.pathname = this._paths.SSO;
    url.search = `target=browser&email=${email}`;
    return url.href;
  },

  /**
   * SSO callback URL that we match to create Felt actors on
   *
   * @returns {string}
   */
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
   * Fetches remote enterprise policies.
   *
   * @returns {Promise<{policies: Record<string, any>}>}
   */
  async getRemotePolicies() {
    const payload = await this._get(this._paths.REMOTE_POLICIES);
    return payload;
  },

  /**
   * Ensures that we have a valid session and performs an authenticated fetch against
   * a registered console endpoint. If we get a 401 or 403 refresh and retry once.
   *
   * @param {string} path - Console API to request
   * @param {{_didRefresh?: boolean}} [options]
   * @throws {InvalidAuthError|Error}
   * @returns {Promise<any>} Parsed JSON response body.
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
   * Ensures a non-expired access token is available, refreshing if it's expiring soon.
   *
   * @returns {Promise<void>}
   */
  async _ensureValidSession() {
    const td = this.tokenData;
    if (!td?.accessToken || td.isExpiringSoon()) {
      await this._refreshSession();
    }
    if (!this.tokenData?.accessToken) {
      // We're not handling reauthentication just yet.
      throw new InvalidAuthError(
        "Unhandled reauthentication",
        "UNHANDLED_REAUTHENTICATION"
      );
    }
  },

  /**
   * Refreshes the session using a refresh token.
   * Uses the provided token if given; otherwise the stored token.
   * Serializes concurrent refreshes via an internal promise.
   *
   * @throws {InvalidAuthError} If unable to refresh session
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
        const e = new ReauthRequiredError(
          "No refresh token available",
          "MISSING_REFRESH_TOKEN"
        );
        console.error(e);
        this.promptForReauthentication();
        return;
      }
      let res;
      try {
        const url = this.constructURI(this._paths.TOKEN);
        res = await fetch(url, {
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
      } catch (cause) {
        throw new InvalidAuthError(
          "Token refresh request failed",
          "TOKEN_REFRESH_FAILED",
          { cause }
        );
      }

      if (res.status === 401 || res.status === 403) {
        const e = new ReauthRequiredError(
          "Invalid refresh token",
          "INVALID_REFRESH_TOKEN",
          { status: res.status }
        );
        console.error(e);
        this.promptForReauthentication();
        return;
      }

      // TODO: Handle network issues, offline support, etc.

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new InvalidAuthError(
          `Token refresh failed (${res.status}): ${text}`,
          "TOKEN_REFRESH_FAILED"
        );
      }

      const t = await res.json();
      this.ensureTokenData(t);

      Services.prefs.setStringPref(
        PREFS.REFRESH_TOKEN,
        this.tokenData.refreshToken
      );
    })().finally(() => {
      this._refreshPromise = null;
    });
    return this._refreshPromise;
  },

  /**
   * If unable to refresh the session, prompt for user reauthentication
   * to obtain a valid set of access and refresh token.
   */
  promptForReauthentication() {
    this.clearTokenData();
    // TODO: Handle Re-authentication
  },

  /**
   * Populates in-memory token state upon initial authentication
   * against the enterprise console or refresh.
   *
   * @param {object} tokenData - Token payload from the console.
   */
  ensureTokenData(tokenData) {
    const { access_token, refresh_token, expires_in, token_type } = tokenData;
    this.tokenData = new ConsoleTokenData(
      access_token,
      refresh_token,
      expires_in,
      token_type
    );
  },

  /**
   * Clears persisted and in-memory token data.
   */
  clearTokenData() {
    this.tokenData = null;
    Services.prefs.clearUserPref(PREFS.REFRESH_TOKEN);
  },

  /**
   * Tears down the client by clearing tokens and resetting internal state.
   */
  uninit() {
    this.clearTokenData();
    this._refreshPromise = null;
  },
};
