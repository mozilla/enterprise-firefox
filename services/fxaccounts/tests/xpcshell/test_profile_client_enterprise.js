/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { FxAccountsProfileClient, FxAccountsProfileClientError } =
  ChromeUtils.importESModule(
    "resource://gre/modules/FxAccountsProfileClient.sys.mjs"
  );

// ConsoleClient initializes itself on import, which has to happen before
// Services.felt is replaced with a fake claiming to be a Felt-managed browser.
ChromeUtils.importESModule(
  "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs"
);

const PROFILE_BODY =
  '{"email":"user@example.com","uid":"0d5c1a89b8c54580b8e3e8adadae864a"}';
const SUCCESS = { success: true, status: 200, headers: {}, body: PROFILE_BODY };
const UNAUTHORIZED = { status: 401, body: '{"code":401,"errno":110}' };

/**
 * Replaces Services.felt with a fake standing in for a Felt-managed browser.
 *
 * @param {object} felt
 * @param {string} felt.token
 *   The console access token Felt currently holds. Tests rotate it by
 *   assigning to this property.
 */
function installFakeFelt(felt) {
  const had = Object.prototype.hasOwnProperty.call(Services, "felt");
  const prev = had ? Services.felt : undefined;
  Object.defineProperty(Services, "felt", {
    value: {
      isFeltBrowser: () => true,
      getAccessTokenIfValid: () => felt.token,
    },
    configurable: true,
    writable: true,
  });
  return {
    [Symbol.dispose]() {
      if (had) {
        Services.felt = prev;
      } else {
        delete Services.felt;
      }
    },
  };
}

/**
 * Creates a profile client whose requests are answered from `responses`, in
 * order. Returns the client and the Authorization header of each request.
 *
 * @param {object} fxai
 * @param {object[]} responses
 * @param {Function} [onDispatch]
 *   Called with the request index right before a response is handed out.
 */
function createClient(fxai, responses, onDispatch = () => {}) {
  const client = new FxAccountsProfileClient({
    serverURL: "http://127.0.0.1:1111/v1",
    fxai,
  });
  const authHeaders = [];
  client._Request = function () {
    return {
      setHeader(name, value) {
        if (name == "Authorization") {
          authHeaders.push(value);
        }
      },
      async dispatch() {
        onDispatch(authHeaders.length - 1);
        this.response = responses[authHeaders.length - 1];
        return this.response;
      },
    };
  };
  return { client, authHeaders };
}

// The console authenticates the profile endpoint with its own access token and
// can't mint FxA OAuth tokens for it, so the cached OAuth token must be ignored
// and the token Felt currently holds must be used for every request.
add_task(async function test_uses_current_console_access_token() {
  const felt = { token: "console-token-1" };
  // eslint-disable-next-line no-unused-vars
  using _felt = installFakeFelt(felt);

  const fxai = {
    getOAuthToken() {
      Assert.ok(false, "No OAuth token should be requested for the profile");
    },
    removeCachedOAuthToken() {
      Assert.ok(false, "No token should be revoked without a 401");
    },
  };
  const { client, authHeaders } = createClient(fxai, [SUCCESS, SUCCESS]);

  let result = await client.fetchProfile();
  Assert.equal(result.body.email, "user@example.com");

  felt.token = "console-token-2";
  result = await client.fetchProfile();
  Assert.equal(result.body.email, "user@example.com");

  Assert.deepEqual(authHeaders, [
    "Bearer console-token-1",
    "Bearer console-token-2",
  ]);
});

// A refresh that lands between reading the token and the console seeing the
// request makes the console reject the old token. The retry must pick up the
// rotated one.
add_task(async function test_401_retries_with_rotated_console_access_token() {
  const felt = { token: "console-token-1" };
  // eslint-disable-next-line no-unused-vars
  using _felt = installFakeFelt(felt);

  const removed = [];
  const fxai = {
    getOAuthToken() {
      Assert.ok(false, "No OAuth token should be requested for the profile");
    },
    removeCachedOAuthToken({ token }) {
      removed.push(token);
    },
  };
  const { client, authHeaders } = createClient(
    fxai,
    [UNAUTHORIZED, SUCCESS],
    index => {
      if (index == 0) {
        felt.token = "console-token-2";
      }
    }
  );

  const result = await client.fetchProfile();
  Assert.equal(result.body.uid, "0d5c1a89b8c54580b8e3e8adadae864a");
  Assert.deepEqual(authHeaders, [
    "Bearer console-token-1",
    "Bearer console-token-2",
  ]);
  Assert.deepEqual(removed, ["console-token-1"]);
});

add_task(async function test_persistent_401_is_reported() {
  const felt = { token: "console-token-1" };
  // eslint-disable-next-line no-unused-vars
  using _felt = installFakeFelt(felt);

  const fxai = {
    getOAuthToken() {
      Assert.ok(false, "No OAuth token should be requested for the profile");
    },
    removeCachedOAuthToken() {},
  };
  const { client, authHeaders } = createClient(fxai, [
    UNAUTHORIZED,
    UNAUTHORIZED,
  ]);

  await Assert.rejects(
    client.fetchProfile(),
    e => e instanceof FxAccountsProfileClientError && e.code == 401,
    "A 401 that survives the retry is surfaced to the caller"
  );
  Assert.equal(authHeaders.length, 2);
});
