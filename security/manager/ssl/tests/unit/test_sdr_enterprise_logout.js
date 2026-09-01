// Any copyright is dedicated to the Public Domain.
// http://creativecommons.org/publicdomain/zero/1.0/
"use strict";

// Bug 2021342: while the enterprise storage-encryption feature manages the
// internal token's primary password (a console-supplied secret the user does
// not know), SecretDecoderRing::LogoutAndTeardown must not log the token out --
// otherwise later SDR use would prompt for a password the user cannot supply.
// This test is enterprise-gated (run-if = ["enterprise"]) because the guard is
// #if defined(MOZ_ENTERPRISE); on a non-enterprise build the token would log
// out and these assertions would correctly fail.

do_get_profile();

add_task(async function test_enterprise_logout_keeps_token_unlocked() {
  const secret = "primary-secret";
  let token = Cc["@mozilla.org/security/internalkeytoken;1"].createInstance(
    Ci.nsIPKCS11Token
  );
  Assert.ok(!token.isLoggedIn, "token starts logged out");
  await token.changePassword("", secret);

  let sdr = Cc["@mozilla.org/security/sdr;1"].getService(
    Ci.nsISecretDecoderRing
  );
  Assert.ok(sdr.login(secret), "SDR login with the primary secret succeeds");
  Assert.ok(token.isLoggedIn, "token is logged in after the initial unlock");

  // The CLEAR_AUTH_TOKENS path (AuthTokensCleaner -> logoutAndTeardown). The
  // non-token teardown still runs; only PK11_LogoutAll is suppressed.
  sdr.logoutAndTeardown();
  Assert.ok(
    token.isLoggedIn,
    "enterprise-managed token stays logged in through logoutAndTeardown"
  );

  // Logout() is intentionally left unguarded (it has no production caller);
  // only LogoutAndTeardown() is guarded. Verify the narrowing so a future
  // change that re-adds the guard to Logout() is caught.
  sdr.logout();
  Assert.ok(!token.isLoggedIn, "logout() still logs the token out");
});
