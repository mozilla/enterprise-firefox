/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * WIP console client that takes care of all requests to the console during the felt login process.
 * It receives the access_token and refresh_token but does nothing yet.
 * The client should be placed outside of the System Addon since the system addon will only be loaded in felt.
 */

const PREFS = {
  CONSOLE_ADDRESS: "browser.felt.console",
  IS_TESTING_ENVIRONMENT: "browser.felt.is_testing",
  SSO_CALLBACK: "browser.felt.matches",
};

const isTesting = () => {
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
    return isTesting()
      ? Services.prefs.getStringPref(PREFS.CONSOLE_ADDRESS, "")
      : "https://console.enterfox.eu";
  },

  get ENDPOINTS() {
    return {
      SSO: `${this.consoleAddr}/sso/login?target=browser`,
      SSO_CALLBACK: `${this.consoleAddr}/sso/callback?*`,
      REDIRECT_AFTER_SSO: `${this.consoleAddr}/redirect_after_sso`,
      DEFAULT_PREFS: `${this.consoleAddr}/api/browser/hacks/default`,
      REMOTE_POLICIES: `${this.consoleAddr}/api/browser/policies`,
    };
  },

  get ssoUri() {
    return this.ENDPOINTS.SSO;
  },

  get ssoCallbackUri() {
    return isTesting()
      ? Services.prefs.getStringPref(PREFS.SSO_CALLBACK, "")
      : this.ENDPOINTS.SSO_CALLBACK;
  },

  async fetchPolicies(url) {
    console.debug("ConsoleClient: fetchPolicies");

    let res;
    try {
      res = await fetch(url);
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

  async getDefaultPrefs() {
    console.debug("ConsoleClient: getDefaultPrefs");
    const payload = await this.fetchPolicies(this.ENDPOINTS.DEFAULT_PREFS);
    return payload;
  },

  async getRemotePolicies() {
    console.debug("ConsoleClient: getRemotePolicies");
    const payload = await this.fetchPolicies(this.ENDPOINTS.REMOTE_POLICIES);
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
