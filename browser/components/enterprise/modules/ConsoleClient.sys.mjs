/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  TelemetryEnvironment: "resource://gre/modules/TelemetryEnvironment.sys.mjs",
});

/**
 * ConsoleClient takes care of all communication with the remote enterprise console.
 */

/**
 * Preferences used to integrate the a remote enterprise console
 */
export const PREFS = {
  CONSOLE_ADDRESS: "enterprise.console.address",
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
 * Client for interacting with the Enterprise Console API.
 * Manages token state and provides helper methods for common endpoints.
 */
export const ConsoleClient = {
  _refreshPromise: null,

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
      SIGNOUT: "/sso/logout",
      SSO_CALLBACK: "/sso/callback",
      STARTUP_PREFS: "/api/browser/hacks/startup",
      DEFAULT_PREFS: "/api/browser/hacks/default",
      REMOTE_POLICIES: "/api/browser/policies",
      KEY: "/api/browser/key",
      TOKEN: "/sso/token",
      DEVICE_POSTURE: "/sso/device_posture",
      WHOAMI: "/api/browser/whoami",
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
   * @param {string} devicePostureToken - Token received for device posture
   * @returns {nsIURI}
   */
  constructSsoLoginURI(email, devicePostureToken) {
    const url = this.consoleBaseURI;
    url.pathname = this._paths.SSO;
    url.searchParams.set("target", "browser");
    url.searchParams.set("email", email);
    url.searchParams.set("devicePostureToken", devicePostureToken);
    // Consumer expects uri as nsIURI
    const uri = Services.io.newURI(url.href);
    return uri;
  },

  /**
   * SSO callback uri that we match to create Felt actors on
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
   * Collect the device posture data and send them to the console.
   *
   * @returns {Promise<{posture: string}>} Token reported by console.
   */
  async sendDevicePosture() {
    const devicePosture = this._collectDevicePosture();
    const url = this.constructURI(this._paths.DEVICE_POSTURE);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(devicePosture),
    });

    if (res.ok) {
      return await res.json();
    }

    const text = await res.text().catch(() => "");
    throw new Error(`Post failed (${res.status}): ${text}`);
  },

  /**
   * Fetches user information from the current session.
   *
   * @returns {Promise<object>}
   */
  async getLoggedInUserInfo() {
    const payload = await this._get(this._paths.WHOAMI);
    return payload;
  },

  /**
   * Retrieves primary secret used for enterprise storage encryption.
   *
   * @returns {Promise<Record<string, any>>}
   */
  async getPrimarySecret() {
    const payload = await this._get(this._paths.KEY);
    return payload;
  },

  /**
   * Ensures that we have a valid session and performs an authenticated fetch against
   * a registered console endpoint. If we get a 401 or 403 refresh and retry once.
   *
   * @param {string} path - Console API to request
   * @param {string} method - Console API method to use, GET or POST
   * @param {{_didRefresh?: boolean}} [options]
   * @throws {InvalidAuthError|Error}
   * @returns {Promise<any>} Parsed JSON response body.
   */
  async _get(path, method = "GET", { _didRefresh = false } = {}) {
    const headers = new Headers({});
    const accessToken = await this.getAccessToken();
    headers.set("Authorization", `Bearer ${accessToken}`);

    const url = this.constructURI(path);
    const res = await fetch(url, { method, headers });

    if (res.ok) {
      return await res.json();
    }

    if ((res.status === 403 || res.status === 401) && !_didRefresh) {
      await this._refreshSession();
      return this._get(path, method, { _didRefresh: true });
    }

    const text = await res.text().catch(() => "");
    throw new Error(`Fetch failed (${res.status}): ${text}`);
  },

  /**
   * Sends a POST request with the same session validity check as GET above.
   *
   * @param {string} path - Console API to request
   * @throws {InvalidAuthError|Error}
   * @returns {Promise<any>} Parsed JSON response body.
   */
  async _post(path) {
    return this._get(path, "POST");
  },

  /**
   * Ensures a non-expired access token is available, refreshing if it's expiring soon.
   *
   * @returns {Promise<string>}
   */
  async getAccessToken() {
    let accessToken = Services.felt.getAccessTokenIfValid();
    if (!accessToken) {
      await this._refreshSession();
      accessToken = Services.felt.getAccessTokenIfValid();
    }
    if (!accessToken) {
      // We're not handling reauthentication just yet.
      throw new InvalidAuthError(
        "Unhandled reauthentication",
        "UNHANDLED_REAUTHENTICATION"
      );
    }
    return accessToken;
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
      let refreshToken = Services.felt.getRefreshToken();
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

      const { access_token, refresh_token, expires_in } = await res.json();
      Services.felt.setTokens(access_token, refresh_token, expires_in);
    })().finally(() => {
      this._refreshPromise = null;
    });
    return this._refreshPromise;
  },

  /**
   * @typedef {object} DeviceNetwork
   * @property {null} ipv4 IPv4 address, TBD
   * @property {null} ipv6 IPv6 address, TBD
   */

  /**
   * @typedef {object} DevicePosture
   * @property {object} os Telemetry-reported os information.
   * @property {object|undefined} security Telemetry-reported security software info (windows only)
   * @property {object} build Telemetry-reported build info info
   * @property {DeviceNetwork} network Network posture (placeholders for now).
   */

  /**
   * Collects the device posture from TelemetryEnvironment.currentEnvironment
   * and others data sources.
   *
   * @returns {DevicePosture} devicePosture
   */
  _collectDevicePosture() {
    const devicePosturePayload = {
      os: lazy.TelemetryEnvironment.currentEnvironment.system.os,
      security: lazy.TelemetryEnvironment.currentEnvironment.system.sec,
      build: lazy.TelemetryEnvironment.currentEnvironment.build,
      // TODO: Client posture IP addr is P2, to be filled later.
      network: {
        ipv4: null,
        ipv6: null,
      },
    };
    return devicePosturePayload;
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
   * Clears persisted and in-memory token data.
   */
  clearTokenData() {
    this.tokenData = null;
    Services.felt.setTokens("", "", 0);
  },

  /**
   * Perform signout against the console and share the information down to
   * XPCOM to make FELT aware.
   *
   * This is expected to be executed from the browser side.
   */
  async signout() {
    if (!Services.felt.isFeltBrowser()) {
      throw new Error(
        "Performing signout from something else than browser is wrong"
      );
    }

    // TODO: Assert or force-enable session restore?

    const res = await this._post(this._paths.SIGNOUT);
    // Server should maybe return better JSON?
    if (res == null) {
      // After successful server-side logout clear local state and notify FELT.
      this.clearTokenData();

      // Make sure we signal early enough to the system that FELT should take
      // over. Relevant at least for macOS dock icon. Not having this would
      // at least intermittently result in missing dock icon for FELT after
      // signout.
      Services.felt.makeBackgroundProcess(true);

      // Notify FELT that we are logging out so the shutdown is a normal one
      // that should not be followed by restarting the process.
      Services.felt.performSignout();

      Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
      return;
    }

    throw new Error(`Post failed: (${res})`);
  },

  /**
   * Register shutdown observer to clean up the client.
   */
  init() {
    Services.obs.addObserver(this, "xpcom-shutdown");
    return this;
  },

  observe(_, topic) {
    switch (topic) {
      case "xpcom-shutdown": {
        Services.obs.removeObserver(this, "xpcom-shutdown");
        this.clearTokenData();
        this._refreshPromise = null;
      }
    }
  },
}.init();
