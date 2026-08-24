/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PREF_NAME = "dom.security.https_only_mode";

// Served over http, but has no valid certificate for https, so the HTTPS-Only
// upgrade fails and the HTTPS-Only error page is shown when the policy is
// active. Without the policy the http page loads normally.
// eslint-disable-next-line sdl/no-insecure-url
const TEST_URL = "http://nocert.example.com";

function waitForPage(browser) {
  return Promise.race([
    BrowserTestUtils.waitForErrorPage(browser),
    BrowserTestUtils.browserLoaded(browser),
  ]);
}

async function navigateAndCheckErrorPage(browser, isExpectingErrorPage) {
  let loaded = waitForPage(browser);
  BrowserTestUtils.startLoadingURIString(browser, TEST_URL);
  await loaded;

  await SpecialPowers.spawn(
    browser,
    [isExpectingErrorPage],
    async _expectErrorPage => {
      const doc = content.document;
      is(
        doc.documentURI.startsWith("about:httpsonlyerror") &&
          doc.body.innerHTML.includes("about-httpsonly-title-alert"),
        _expectErrorPage,
        _expectErrorPage
          ? "Expected the HTTPS-Only error page"
          : "Expected the page to load over http"
      );
    }
  );
}

function checkPref(locked, value) {
  Assert.equal(
    Services.prefs.prefIsLocked(PREF_NAME),
    locked,
    `${PREF_NAME} is ${locked ? "locked" : "unlocked"}`
  );
  Assert.strictEqual(
    Services.prefs.getBoolPref(PREF_NAME),
    value,
    `${PREF_NAME} is ${value}`
  );
}

// Changing the HttpsOnlyMode value through a live policy update must take
// effect on the next navigation without a restart.
add_task(async function test_https_only_mode_live_update() {
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:blank" },
    async browser => {
      info("Applying HttpsOnlyMode: enabled");
      await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
        {
          policies: {
            HttpsOnlyMode: "enabled",
          },
        },
        null
      );

      // "enabled" sets the default value to true without locking it.
      checkPref(false, true);
      await navigateAndCheckErrorPage(browser, true);

      info("Live-updating HttpsOnlyMode to disallowed");
      await waitForLivePolicyUpdate({ HttpsOnlyMode: "disallowed" });

      // "disallowed" sets and locks the pref to false.
      checkPref(true, false);
      await navigateAndCheckErrorPage(browser, false);

      info("Live-updating HttpsOnlyMode to force_enabled");
      await waitForLivePolicyUpdate({ HttpsOnlyMode: "force_enabled" });

      // "force_enabled" sets and locks the pref to true.
      checkPref(true, true);
      await navigateAndCheckErrorPage(browser, true);
    }
  );
});

// Removing HttpsOnlyMode through a live policy update must restore the previous
// browsing behavior and preference state without a restart.
add_task(async function test_https_only_mode_live_removal() {
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:blank" },
    async browser => {
      // Start with a clean engine
      await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
        { policies: {} },
        null
      );

      // The pref defaults to false and is unlocked; the http page loads.
      checkPref(false, false);
      await navigateAndCheckErrorPage(browser, false);

      info("Applying HttpsOnlyMode: force_enabled");
      await waitForLivePolicyUpdate({ HttpsOnlyMode: "force_enabled" });

      // "force_enabled" sets and locks the pref to true.
      checkPref(true, true);
      await navigateAndCheckErrorPage(browser, true);

      info("Removing HttpsOnlyMode");
      await waitForLivePolicyUpdate({});

      // The pref is unlocked again and its initial value restored.
      checkPref(false, false);
      await navigateAndCheckErrorPage(browser, false);
    }
  );
});

// "allowed" is the default and never touches the pref, so removing it
// must preserve the pref state
add_task(
  async function test_https_only_mode_allowed_removal_preserves_pref_state() {
    // Start with a clean engine
    await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
      { policies: {} },
      null
    );

    // Simulate the pref being locked prior to applying the policy
    Services.prefs.lockPref(PREF_NAME);
    checkPref(true, false);

    info("Applying HttpsOnlyMode: allowed");
    await waitForLivePolicyUpdate({ HttpsOnlyMode: "allowed" });

    // "allowed" is a no-op on the pref.
    checkPref(true, false);

    info("Removing HttpsOnlyMode");
    await waitForLivePolicyUpdate({});

    // The externally-set lock is preserved since "allowed" never changed it.
    checkPref(true, false);

    Services.prefs.unlockPref(PREF_NAME);
  }
);
