/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * WIP console client that takes care of all requests to the console during the felt login process.
 * It receives the access_token and refresh_token but does nothing yet.
 * The client should be placed outside of the System Addon since the system addon will only be loaded in felt.
 */

const PREFS = {
  CONSOLE_ADDRESS: "enterprise.console.address",
  IS_TESTING_ENVIRONMENT: "enterprise.is_testing",
};

export const isTesting = () => {
  return Services.prefs.getBoolPref(PREFS.IS_TESTING_ENVIRONMENT, false);
};

/**
 *
 */
class ConsoleTokenData {
  constructor(accessToken, refreshToken, expiresIn, tokenType) {
    this._accessToken = accessToken;
    this._refreshToken = refreshToken;
    this._expiresIn = expiresIn;
    this._tokenType = tokenType;
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

  get expiresIn() {
    return this._expiresIn;
  }

  set expiresIn(value) {
    this._expiresIn = value;
  }

  get tokenType() {
    return this._tokenType;
  }

  set tokenType(value) {
    this._tokenType = value;
  }

  isExpired() {}
}

export const ConsoleClient = {
  ENTERPRISE_PROFILE: "enterprise-profile",

  _consoleTokenData: null,

  get consoleTokenData() {
    return this._consoleTokenData;
  },
  set consoleTokenData(val) {
    this._consoleTokenData = val;
  },

  get consoleAddr() {
    return Services.prefs.getStringPref(
      PREFS.CONSOLE_ADDRESS,
      "https://console.enterfox.eu"
    );
  },

  get consoleAddrMatchingCallback() {
    // Dropping the port is required here because the matcher being used by
    // JSActors code relies on WebExtensions MatchPattern
    // https://searchfox.org/firefox-main/source/toolkit/components/extensions/MatchPattern.cpp#370-384
    // The match pattern should then NOT use any port otherwise matching would
    // not happen.
    const uri = Services.io.newURI(this.consoleAddr);
    return `${uri.scheme}://${uri.host}`;
  },

  get ENDPOINTS() {
    return {
      SSO: `${this.consoleAddr}/sso/login?target=browser`,
      SSO_CALLBACK: `${this.consoleAddrMatchingCallback}/sso/callback?*`,
      REDIRECT_AFTER_SSO: `${this.consoleAddr}/redirect_after_sso`,
      STARTUP_PREFS: `${this.consoleAddr}/api/browser/hacks/startup`,
      DEFAULT_PREFS: `${this.consoleAddr}/api/browser/hacks/default`,
      REMOTE_POLICIES: `${this.consoleAddr}/api/browser/policies`,
      KEY: `${this.consoleAddr}/api/browser/key`,
    };
  },

  get ssoUri() {
    return this.ENDPOINTS.SSO;
  },

  get ssoCallbackUri() {
    return this.ENDPOINTS.SSO_CALLBACK;
  },

  async fetch(url) {
    console.debug("ConsoleClient: fetch");

    // Get the access token from preferences
    let accessToken;
    try {
      accessToken = Services.prefs.getStringPref("browser.policies.access_token", "");
    } catch (e) {
      console.error("ConsoleClient.fetch: Failed to get access_token from prefs", e);
    }

    const headers = {};
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
      console.debug("ConsoleClient: fetch with Authorization header");
    } else {
      console.warn("ConsoleClient: fetch without access_token");
    }

    let res;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      console.error(`ConsoleClient.fetch: Request failed for ${url}`, e);
      throw e;
    }

    if (!res?.ok) {
      let text = "";
      try {
        text = await res.text();
      } catch {}
      const status = res?.status ?? "no-response";
      const err = new Error(
        `Fetch failed (${status}) for ${url}: ${text || "<empty body>"}`
      );
      console.error("ConsoleClient.fetch error:", err);
      throw err;
    }

    try {
      return await res.json();
    } catch (e) {
      const err = new Error(`Invalid JSON from ${url}`);
      console.error(err, e);
      throw err;
    }
  },

  // Gets the primary secret from the console backend
  async getPrimarySecret() {
    console.debug("ConsoleClient: getPrimarySecret")
    const payload = await this.fetch(this.ENDPOINTS.KEY);
    return payload;
  },

  // prefs that needs to be read at startup, i.e., written to profile's
  // prefs.js
  async getStartupPrefs() {
    console.debug("ConsoleClient: getStartupPrefs");
    const payload = await this.fetch(this.ENDPOINTS.STARTUP_PREFS);
    return payload;
  },

  // prefs that do not need to be written and can be sent during runtime
  async getDefaultPrefs() {
    console.debug("ConsoleClient: getDefaultPrefs");
    const payload = await this.fetch(this.ENDPOINTS.DEFAULT_PREFS);
    return payload;
  },

  async getRemotePolicies() {
    console.debug("ConsoleClient: getRemotePolicies");
    const payload = await this.fetch(this.ENDPOINTS.REMOTE_POLICIES);
    return payload;
  },

  // Should be used instead of FeltProcessParent setting
  // the console address as preference when starting Firefox
  isReadyToPollPolicies() {},

  sendDevicePosture() {},

  onConsoleTokenDataReceived(tokenData) {
    console.debug("ConsoleClient: onReceivedConsoleToken");
    const { access_token, refresh_token, expires_in, token_type } = tokenData;
    this._consoleTokenData = new ConsoleTokenData(
      access_token,
      refresh_token,
      expires_in,
      token_type
    );
  },
};
