/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

const FELT_REFRESH_TIMEOUT = 60000;

// Bound a single console request so a stalled server can't wedge the poller.
const XHR_TIMEOUT_MS = 60000;

// The login flow this client speaks, reported on the SSO login URL: a callback
// carrying a one-time token that the token endpoint redeems with the posture.
const SSO_LOGIN_VERSION = "v2";

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleProxyBypassFilter:
    "resource://gre/modules/enterprise/ConsoleProxyBypassFilter.sys.mjs",
  EnterpriseCommon:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  FeltStorage: "resource://gre/modules/enterprise/FeltStorage.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("ConsoleClient");
});

/**
 * Remote enterprise console preference
 */
export const CONSOLE_ADDRESS_PREF = "enterprise.console.address";

/**
 * Placeholder value the pref holds on generic (non-repacked) builds, where
 * the AutoConfig file does not bake in a real console address. The actual
 * address then comes from the MOZ_ENTERPRISE_CONSOLE_URL environment
 * variable or from felt.json, filled in by the pre-profile console setup
 * dialog. Keep in sync with CONSOLE_ADDRESS_PLACEHOLDER in the
 * enterprise-console crate (toolkit/components/enterprise/rust), which holds
 * this resolution logic for the native consumers; resolveConsoleAddress below
 * mirrors it in JS.
 */
export const CONSOLE_ADDRESS_PLACEHOLDER = "FIREFOX_ENTERPRISE_GENERIC";

async function resolveConsoleAddress(prefValue) {
  if (prefValue !== CONSOLE_ADDRESS_PLACEHOLDER) {
    return prefValue;
  }
  const envUrl = Services.env.get("MOZ_ENTERPRISE_CONSOLE_URL");
  if (envUrl) {
    return envUrl;
  }
  await lazy.FeltStorage.init();
  const storedUrl = lazy.FeltStorage.getConsoleAddress();
  if (!storedUrl) {
    throw new Error(
      "Console address is the generic placeholder and no stored address exists"
    );
  }
  return storedUrl;
}

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
 * Client taking care of the communication with the enterprise console.
 */
export const ConsoleClient = {
  /**
   * This is our guard against concurrent access token refresh operations on the browser side.
   * When a refresh is in progress, this promise encapsulates the ongoing operation.
   * If the promise present on subsequent calls, (i.e. a refresh operation is already underway),
   * it is simply returned to the caller, eventually resolving.
   * Otherwise, the promise is created and assigned to _refreshPromise.
   *
   * Since the refresh operation involves IPC communication with the console process,
   * the resolve/reject functions of the promise are also pulled out to be called when the console/FELT
   * signals that a token refresh has successfully completed or failed.
   */
  _refreshPromise: null,
  _consoleUriReadyPromise: null,

  /**
   * This promise guards agains multiple refresh operations on the console/FELT side, similar
   * to what happens on the browser side (`_refreshPromise`).
   *
   * Concurrent refresh operations are all answered by returning the ongoing promise rather
   * than starting a new refresh process.
   */
  _feltRefreshPromise: null,

  /**
   * Base URL of the remote enterprise console
   *
   * @throws {Error}
   * @returns {Promise<URL>}
   */
  get consoleBaseURI() {
    if (!this._consoleUriReadyPromise) {
      this._consoleUriReadyPromise = new Promise((resolve, reject) => {
        try {
          const consoleURI = Services.prefs.getStringPref(CONSOLE_ADDRESS_PREF);
          resolve(resolveConsoleAddress(consoleURI));
        } catch (e) {
          lazy.log.warn(`Missing console URI. Waiting on pref change.`);
          const consolePrefObserver = {
            observe(_, topic) {
              switch (topic) {
                case "nsPref:changed":
                  Services.prefs.removeObserver(
                    CONSOLE_ADDRESS_PREF,
                    consolePrefObserver
                  );
                  lazy.log.warn(`Missing console URI. Pref changed, checking.`);
                  try {
                    const consoleURI =
                      Services.prefs.getStringPref(CONSOLE_ADDRESS_PREF);
                    resolve(resolveConsoleAddress(consoleURI));
                  } catch (ex) {
                    lazy.log.error(
                      `Critical misconfiguration: Missing console URI`
                    );
                    reject(ex);
                  }
                  break;
              }
            },
          };
          Services.prefs.addObserver(CONSOLE_ADDRESS_PREF, consolePrefObserver);
        }
      });
      // A failure (e.g. felt.json unreadable at that instant) must not be
      // cached for the rest of the session: clear the slot so the next
      // access retries the resolution. Callers still see the rejection.
      this._consoleUriReadyPromise.catch(e => {
        lazy.log.error("Failed to resolve the console address", e);
        this._consoleUriReadyPromise = null;
      });
    }
    return this._consoleUriReadyPromise.then(url => new URL(url));
  },

  /**
   * Paths to API endpoints of the remote enterprise console
   */
  get _paths() {
    // Strip off any trailing "a1", etc.
    let majorMinorPatchVersion = Services.appinfo.version.replace(
      /[a-zA-Z].*$/,
      ""
    );
    return {
      SSO: "/sso/login",
      SIGNOUT: "/sso/logout",
      SSO_CALLBACK: "/sso/callback",
      CONFIG: "/api/browser/config",
      REMOTE_POLICIES: "/api/browser/policies",
      KEY: "/api/browser/key",
      TOKEN: "/api/browser/sso/token",
      WHOAMI: "/api/browser/whoami",
      FXACCOUNT: "/api/browser/account",
      // Right now we always pass 0.0.0 as the current version
      // to the console because we don't cache it on disk.
      DLP_WASM: `/api/browser/content-analysis-wasm/update/${majorMinorPatchVersion}/${Services.appinfo.appBuildID}/0.0.0`,
    };
  },

  /**
   * Constructs an absolute URL for a console API path.
   *
   * @param {string} path
   * @returns {string} Absolute URL string.
   */
  async constructURI(path) {
    const url = await this.consoleBaseURI;
    url.pathname = path;
    return url.href;
  },

  /**
   * Checks that the configured console is reachable before starting the SSO flow.
   * Any HTTP response means the host is reachable; only network-level failures
   * reject, in the shape FeltErrorReport.handleXhrError expects.
   *
   * @throws {TypeError} On a network-level failure.
   * @returns {Promise<void>}
   */
  async probeConsoleReachable() {
    const url = await this.constructURI("");
    await this._xhrFetch(url, { method: "GET" });
  },

  /**
   * Constructs the SSO login URL for the provided email.
   *
   * Identifies the user, the device, and the login flow this client speaks, which
   * selects the callback and the token grant the console answers with. It names no
   * platform: the client selects its own list out of the posture configuration
   * (see EdrAgents in DevicePosture.sys.mjs).
   *
   * @param {string} email - Email address to prefill for SSO initiation.
   * @returns {Promise<nsIURI>}
   */
  async constructSsoLoginURI(email) {
    const deviceId = lazy.FeltStorage.getDeviceId();
    const url = await this.consoleBaseURI;
    url.pathname = this._paths.SSO;
    url.searchParams.set("target", "browser");
    url.searchParams.set("email", email);
    url.searchParams.set("deviceId", deviceId);
    url.searchParams.set("version", SSO_LOGIN_VERSION);
    // Consumer expects uri as nsIURI
    const uri = Services.io.newURI(url.href);
    return uri;
  },

  /**
   * Redeems the SSO one-time-token for the session tokens, reporting the device
   * posture in the same request: the console mints no session without a posture to
   * record against it, so this is the one call that starts a session.
   *
   * @param {string} oneTimeToken
   * @param {DevicePosture|null} posture
   * @returns {Promise<{access_token, refresh_token, expires_in}>}
   * @throws {Error}
   */
  async redeemOneTimeToken(oneTimeToken, posture) {
    const url = await this.constructURI(this._paths.TOKEN);
    const res = await this._xhrFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "one_time_token",
        one_time_token: oneTimeToken,
        posture,
      }),
    });

    if (res.ok) {
      return res.json();
    }

    // The status tells a console that refused the request (4xx, e.g. a posture it
    // will not accept) from one that could not answer.
    const text = await res.text().catch(() => "");
    const e = new Error(
      `One-time-token redemption failed (${res.status}): ${text}`
    );
    e.status = res.status;
    throw e;
  },

  /**
   * SSO callback uri that we match to create Felt actors on
   *
   * @returns {string}
   */
  get ssoCallbackUriMatchPattern() {
    // This should be: await this.consoleBaseURI but the method being a getter
    // it cannot be marked "async", and thus cannot have "await" in its body.
    return this.consoleBaseURI.then(url => {
      url.pathname = this._paths.SSO_CALLBACK;

      // Dropping the port is required here because the matcher being used by
      // JSActors code relies on WebExtensions MatchPattern
      // https://searchfox.org/firefox-main/source/toolkit/components/extensions/MatchPattern.cpp#370-384
      // The match pattern should then NOT use any port otherwise matching would
      // not happen.
      url.port = "";
      return url.href + "?*";
    });
  },

  /**
   * Fetches configurations for Firefox
   *
   * @returns {Promise<object>}
   */
  async getFirefoxConfigs() {
    return this._get(this._paths.CONFIG);
  },

  /**
   * Fetches remote enterprise policies.
   *
   * A plain authenticated GET; posture is reported on the same cadence by the
   * Felt posture monitor, not here.
   *
   * @returns {Promise<{policies: Record<string, any>}>}
   */
  async getRemotePolicies() {
    return this._get(this._paths.REMOTE_POLICIES);
  },

  /**
   * Fetch the account data used for fxa and sync.
   *
   * @returns {Promise<object>}
   */
  async getFxAccountData() {
    const deviceId = Services.prefs.getStringPref(
      lazy.EnterpriseCommon.ENTERPRISE_DEVICE_ID_PREF,
      ""
    );
    const body = {};
    if (deviceId !== "") {
      body.device_id = deviceId;
    }
    return this._post(this._paths.FXACCOUNT, body);
  },

  /**
   * Fetch-like wrapper that exposes detailed network errors.
   * Uses XMLHttpRequest internally to access channel.status on error,
   * which native fetch() does not expose.
   *
   * Limitations compared to native fetch():
   * - Response object only has: ok, status, json(), text(), arrayBuffer()
   * - Missing: statusText, headers, url, redirected, clone(), blob(),
   *   formData()
   * - json()/text() can be called multiple times (no body consumption)
   *
   * If the passed in responseType is "arraybuffer", then calling json() or text()
   * will throw an exception.
   *
   * @param {string} url - The URL to fetch
   * @param {object} options - Fetch-like options
   * @param {string} [options.method="GET"] - HTTP method
   * @param {object} [options.headers={}] - Request headers
   * @param {string|null} [options.body=null] - Request body
   * @param {""|"arraybuffer"} [options.responseType=""] - XHR response type -
   *   use "arraybuffer" for binary responses and "" for text responses.
   * @returns {Promise<{ok: boolean, status: number, json: Function, text: Function, arrayBuffer: Function}>}
   */
  _xhrFetch(
    url,
    { method = "GET", headers = {}, body = null, responseType = "" } = {}
  ) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.timeout = XHR_TIMEOUT_MS;
      xhr.responseType = responseType;

      // Handle both plain objects and Headers instances
      const headerEntries = Headers.isInstance(headers)
        ? headers.entries()
        : Object.entries(headers);
      for (const [key, value] of headerEntries) {
        xhr.setRequestHeader(key, value);
      }

      xhr.onload = () => {
        const response = {
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          json() {
            try {
              return Promise.resolve(JSON.parse(xhr.responseText));
            } catch (e) {
              return Promise.reject(e);
            }
          },
          text: () => Promise.resolve(xhr.responseText),
          arrayBuffer: () => Promise.resolve(xhr.response),
        };
        resolve(response);
      };

      xhr.onerror = () => {
        const channelStatus = xhr.channel?.status ?? null;
        reject(
          new TypeError("ConsoleClientXHRError", {
            cause: { hostname: new URL(url).host, channelStatus },
          })
        );
      };

      xhr.ontimeout = () => {
        reject(new TypeError("NS_ERROR_NET_TIMEOUT"));
      };

      xhr.onabort = () => {
        reject(new TypeError("NS_BINDING_ABORTED"));
      };

      xhr.send(body);
    });
  },

  /**
   * Fetches user information from the current session.
   *
   * @returns {Promise<object>}
   */
  async getLoggedInUserInfo() {
    return this._get(this._paths.WHOAMI);
  },

  /**
   * Retrieves primary secret used for enterprise storage encryption.
   *
   * @returns {Promise<Record<string, any>>}
   */
  async getPrimarySecret() {
    return this._get(this._paths.KEY);
  },

  /**
   * Fetches the bytes of the DLP wasm module.
   *
   * @returns {Promise<ArrayBuffer>}
   */
  async getDlpWasmModule() {
    return this._fetchBinary(this._paths.DLP_WASM);
  },

  /**
   * Ensures that we have a valid session and performs an authenticated fetch against
   * a registered console endpoint. If we get a 401 or 403 refresh and retry once.
   *
   * @param {string} path - Console API to request
   * @param {"GET"|"POST"} method - Console API method to use
   * @param {{ _didRefresh?: boolean, jsonBody?: object }} [options]
   * @throws {Error}
   * @returns {Promise<any>} Parsed JSON response body.
   */
  async _fetch(path, method, { _didRefresh = false, jsonBody = null } = {}) {
    if (method !== "GET" && method !== "POST") {
      throw new TypeError(
        `Invalid method: ${method}. Expected "GET" or "POST".`
      );
    }

    const headers = new Headers({});
    const accessToken = await this.getAccessToken();
    headers.set("Authorization", `Bearer ${accessToken}`);
    headers.set("Accept", "application/json");
    if (jsonBody !== null) {
      headers.set("Content-Type", "application/json");
    }

    const url = await this.constructURI(path);
    const res = await this._xhrFetch(url, {
      method,
      headers,
      body: jsonBody === null ? undefined : JSON.stringify(jsonBody),
    });

    if (res.ok) {
      return await res.json();
    }

    if ((res.status === 403 || res.status === 401) && !_didRefresh) {
      await this._refreshSession();
      return this._fetch(path, method, { _didRefresh: true, jsonBody });
    }

    const text = await res.text().catch(() => "");
    throw new Error(`Fetch ${method} ${path} failed (${res.status}): ${text}`);
  },

  /**
   * Ensures that we have a valid session and performs an authenticated GET
   * against a registered console endpoint, returning the raw binary body.
   * If we get a 401 or 403 refresh and retry once.
   *
   * @param {string} path - Console API to request
   * @param {{ _didRefresh?: boolean }} [options]
   * @throws {Error}
   * @returns {Promise<ArrayBuffer>}
   */
  async _fetchBinary(path, { _didRefresh = false } = {}) {
    const headers = new Headers({});
    const accessToken = await this.getAccessToken();
    headers.set("Authorization", `Bearer ${accessToken}`);

    const url = await this.constructURI(path);
    const res = await this._xhrFetch(url, {
      method: "GET",
      headers,
      responseType: "arraybuffer",
    });

    if (res.ok) {
      return res.arrayBuffer();
    }

    if ((res.status === 403 || res.status === 401) && !_didRefresh) {
      await this._refreshSession();
      return this._fetchBinary(path, { _didRefresh: true });
    }

    throw new Error(`Fetch GET ${path} failed (${res.status})`);
  },

  /**
   * Initiates a GET request against a registered console endpoint.
   *
   * @param {string} path - Console API to request
   *
   * @throws {Error}
   *
   * @returns {Promise<any>} Promise which resolves to a parsed JSON response body.
   */
  async _get(path) {
    return this._fetch(path, "GET");
  },

  /**
   * Initiates a POST request against a registered console endpoint.
   *
   * @param {string} path - Console API to request
   * @param {object} jsonBody - JSON body
   *
   * @throws {Error}
   *
   * @returns {Promise<any>} Promise which resolves to a parsed JSON response body.
   */
  async _post(path, jsonBody = null) {
    return this._fetch(path, "POST", { jsonBody });
  },

  /**
   * Ensures a non-expired access token is available, refreshing if it's expiring soon.
   *
   * @returns {Promise<string>}
   * @throws {Error}
   */
  async getAccessToken() {
    let accessToken = Services.felt.getAccessTokenIfValid();
    if (Services.felt.isFeltBrowser() && !accessToken) {
      await this._refreshSession();
      accessToken = Services.felt.getAccessTokenIfValid();
    }
    if (!accessToken) {
      // If we are in a Felt-managed Firefox at this point, Felt failed to
      // shut us down correctly after an unsuccessful token refresh.
      // If we are in Felt at this point, the authentication flow has
      // completed, but we do not have a valid token.
      // Either case should not happen normally, so throw an error.
      if (Services.felt.isFeltBrowser()) {
        throw new Error(
          "Firefox does not have a valid token, waiting for Felt to shut us down."
        );
      } else {
        throw new Error(
          "Felt authentication flow has completed, but no valid token is available."
        );
      }
    }
    return accessToken;
  },

  /**
   * Refreshes the session using a refresh token, storing the rotated tokens.
   * Serializes concurrent refreshes via an internal promise.
   * This should only be called from the Felt context.
   *
   * @param {object} [options]
   * @param {DevicePosture|null} [options.posture=null] - Device posture to report
   *   with the refresh, for the console to record.
   * @throws {ReauthRequiredError | Error} If unable to refresh session
   * @returns {Promise<{ access_token, refresh_token, expires_at, posture,
   *   postureSubmitted }>} posture is the refreshed posture configuration (may be
   *   undefined); postureSubmitted is false when this call joined an in-flight
   *   refresh that did not carry the supplied posture.
   */
  async refreshTokens({ posture = null } = {}) {
    // Assert we are in Felt context
    if (!Services.felt.isFeltUI()) {
      throw new Error(
        "refreshTokens(): Called from Browser context, which is not allowed."
      );
    }

    // An in-flight refresh may not have carried this caller's posture, so it
    // reports postureSubmitted=false and the next monitor tick retries.
    if (this._feltRefreshPromise) {
      return this._feltRefreshPromise.then(result => ({
        ...result,
        postureSubmitted: false,
      }));
    }

    // At this point, we are in the Felt UI context and no
    // felt refresh promise exists, so do the actual refresh.
    this._feltRefreshPromise = (async () => {
      const refreshToken = Services.felt.getRefreshToken();
      if (!refreshToken) {
        const e = new ReauthRequiredError(
          "No refresh token available",
          "MISSING_REFRESH_TOKEN"
        );
        lazy.log.error(e);
        throw e;
      }

      const url = await this.constructURI(this._paths.TOKEN);
      const body = {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      };
      if (posture) {
        body.posture = posture;
      }
      // We let any errors that are thrown here bubble up, these should
      // be lower level network errors, i.e. nothing on the HTTP level.
      const res = await this._xhrFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });

      // These are concrete HTTP errors that should trigger
      // a full-blown re-authentication.
      if (res.status === 401 || res.status === 403) {
        throw new ReauthRequiredError(
          "Invalid refresh token",
          "INVALID_REFRESH_TOKEN",
          { status: res.status }
        );
      }

      // Throw an error if the response is not ok (i.e. not a 20x status code),
      // and also neither a 401 or a 403 error (handled above).
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Token refresh failed: ${text}, Status: ${res.status}`);
      }

      const {
        access_token,
        refresh_token,
        expires_in,
        posture: postureConfig,
      } = await res.json();
      const expires_at = Math.floor(Date.now() / 1000) + Number(expires_in);
      // Store the rotated tokens here rather than in the callers: this runs
      // before the guard below clears, so a refresh starting as this one
      // completes cannot read the refresh token this call just spent.
      Services.felt.setTokens(access_token, refresh_token, expires_at);
      return {
        access_token,
        refresh_token,
        expires_at,
        posture: postureConfig,
        postureSubmitted: !!posture,
      };
    })().finally(() => {
      // In any case, clear the felt refresh promise so that a new one can be started.
      this._feltRefreshPromise = null;
    });
    return this._feltRefreshPromise;
  },

  /**
   * Quit Firefox, ignoring any callbacks installed by the page
   * preventing the tab/window from closing.
   *
   * @param {number} [aFlags] - nsIAppStartup quit flags, to which eRestart can
   *   be added to come back up. eForceQuit on its own by default.
   * @returns {void}
   */
  quitIgnoringCanClose(aFlags = Ci.nsIAppStartup.eForceQuit) {
    if (Services.felt.isFeltUI()) {
      throw new Error(
        "quitIgnoringCanClose(): Called from Felt context, which is not allowed."
      );
    }
    for (let win of Services.wm.getEnumerator("navigator:browser")) {
      win.skipNextCanClose = true;
    }
    Services.startup.quit(aFlags);
  },

  /**
   * Refreshes the session by asking FELT to fetch an updated token.
   * Serializes concurrent refresh calls via an internal promise.
   * This should only be called from the browser context.
   *
   * @returns {Promise<void>}
   */
  async _refreshSession() {
    // Assert we are in the browser. Currently, there is no use case for
    // Felt to trigger a session refresh by itself.
    if (!Services.felt.isFeltBrowser()) {
      throw new Error(
        "_refreshSession: called from non-Browser context, which is not allowed."
      );
    }

    // If a refresh is already in progress, return the existing promise.
    if (this._refreshPromise) {
      return this._refreshPromise;
    }

    // Ask FELT to refresh the token. The refresh will be done asynchronously by Felt,
    // eventually either coming back successfully and resolving the promise
    // or we get logged out / killed by a failure to refresh the token.
    //
    // If the timeout fires (Felt did not come back in time and did not log us out),
    // we reject the promise and log us out ourselves.
    const { promise, resolve, reject } = Promise.withResolvers();
    this._refreshResolve = resolve;

    // If we don't get a response within `FELT_REFRESH_TIMEOUT` (should be 60s),
    // sign out and quit.
    const timeoutId = lazy.setTimeout(() => {
      this._refreshPromise = null;
      this._refreshResolve = null;
      Services.felt.performSignout();
      this.quitIgnoringCanClose();
      reject(
        new Error("_refreshSession: Felt failed to respond to re-auth in time.")
      );
    }, FELT_REFRESH_TIMEOUT);

    this._refreshPromise = promise
      .then(() => lazy.clearTimeout(timeoutId))
      .finally(() => {
        // nullify (reset) the promise here
        // and not from outside the async flow
        this._refreshPromise = null;
        this._refreshResolve = null;
      });

    // Kick off the actual refresh
    Services.felt.refreshTokens();

    return this._refreshPromise;
  },

  /**
   * Performs a server-side signout POST request.
   * This is to be called only from the Felt side.
   *
   * @returns {Promise<any>}
   */
  async performServerSignout() {
    return this._post(this._paths.SIGNOUT);
  },

  /**
   * Register shutdown observer to clean up the client.
   */
  init() {
    Services.prefs.addObserver(CONSOLE_ADDRESS_PREF, this);

    if (Services.felt.isFeltBrowser()) {
      Services.obs.addObserver(this, "xpcom-shutdown");
      Services.obs.addObserver(this, "felt-firefox-access-token-refreshed");
      Services.obs.addObserver(this, "felt-firefox-shutdown");

      // Seed the crash reporter with any token already available at startup.
      this._syncCrashReporterAuthToken();

      this.consoleBaseURI.then(
        ({ hostname }) => lazy.ConsoleProxyBypassFilter.register(hostname),
        e => lazy.log.error("Failed to register console proxy bypass:", e)
      );
    }
    return this;
  },

  /**
   * Hand the current access token to the crash reporter so it can authenticate
   * crash report and crash ping uploads with the console.
   * Called on every token update in the browser process.
   */
  _syncCrashReporterAuthToken() {
    try {
      Services.appinfo.setAuthToken(
        Services.felt.getAccessTokenIfValid() || ""
      );
    } catch (e) {
      lazy.log.warn("Failed to sync crash reporter auth token", e);
    }
  },

  observe(_, topic) {
    switch (topic) {
      case "xpcom-shutdown": {
        Services.obs.removeObserver(this, "xpcom-shutdown");
        Services.prefs.removeObserver(CONSOLE_ADDRESS_PREF, this);
        Services.obs.removeObserver(
          this,
          "felt-firefox-access-token-refreshed"
        );
        Services.obs.removeObserver(this, "felt-firefox-shutdown");
        lazy.ConsoleProxyBypassFilter.unregister();
        this._refreshPromise = null;
        this._refreshResolve = null;
        break;
      }
      case "felt-firefox-shutdown": {
        this.quitIgnoringCanClose();
        break;
      }
      case "felt-firefox-access-token-refreshed": {
        // Resolve the promise, if any
        this._refreshResolve?.();
        // The `finally()` block of our promise chain will
        // reset/nullify the promise.
        // Keep the crash reporter's inherited token in sync.
        this._syncCrashReporterAuthToken();
        break;
      }
      case "nsPref:changed": {
        // Console pref was changed, make sure new callers gets a new promise
        this._consoleUriReadyPromise = null;
        if (Services.felt.isFeltBrowser()) {
          this.consoleBaseURI.then(
            ({ hostname }) => lazy.ConsoleProxyBypassFilter.register(hostname),
            e =>
              lazy.log.error("Failed to re-register console proxy bypass:", e)
          );
        }
        break;
      }
    }
  },
}.init();
