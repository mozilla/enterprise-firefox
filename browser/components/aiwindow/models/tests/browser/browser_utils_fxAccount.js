/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { openAIEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs"
);

const { OAUTH_CLIENT_ID, SCOPE_PROFILE_UID, SCOPE_SMART_WINDOW } =
  ChromeUtils.importESModule("resource://gre/modules/FxAccountsCommon.sys.mjs");

const { getFxAccountsSingleton } = ChromeUtils.importESModule(
  "resource://gre/modules/FxAccounts.sys.mjs"
);

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

add_task(async function test_getFxAccountToken_passes_correct_scope() {
  const fakeToken = "fake-oauth-token";
  const fxAccounts = getFxAccountsSingleton();

  const getOAuthTokenStub = sinon
    .stub(fxAccounts, "getOAuthToken")
    .resolves(fakeToken);

  try {
    const token = await openAIEngine.getFxAccountToken();

    Assert.ok(
      getOAuthTokenStub.calledOnce,
      "getOAuthToken should be called once"
    );

    const callArgs = getOAuthTokenStub.getCall(0).args[0];
    Assert.ok(callArgs, "getOAuthToken should be called with arguments");
    Assert.deepEqual(
      callArgs.scope,
      [SCOPE_SMART_WINDOW, SCOPE_PROFILE_UID],
      "getOAuthToken should be called with correct scope array"
    );
    Assert.equal(
      callArgs.client_id,
      OAUTH_CLIENT_ID,
      "getOAuthToken should be called with correct client_id"
    );
    Assert.equal(
      token,
      fakeToken,
      "getFxAccountToken should return the token from getOAuthToken"
    );
  } finally {
    getOAuthTokenStub.restore();
  }
});

add_task(async function test_getFxAccountToken_returns_null_on_error() {
  const fxAccounts = getFxAccountsSingleton();

  const getOAuthTokenStub = sinon
    .stub(fxAccounts, "getOAuthToken")
    .rejects(new Error("FxA authentication failed"));

  try {
    const token = await openAIEngine.getFxAccountToken();

    Assert.ok(
      getOAuthTokenStub.calledOnce,
      "getOAuthToken should be called once"
    );
    Assert.equal(
      token,
      null,
      "getFxAccountToken should return null when getOAuthToken throws an error"
    );
  } finally {
    getOAuthTokenStub.restore();
  }
});
