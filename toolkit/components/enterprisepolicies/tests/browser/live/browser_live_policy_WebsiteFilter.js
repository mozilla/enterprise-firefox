/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const SUPPORT_FILES_PATH =
  "http://mochi.test:8888/browser/browser/components/enterprisepolicies/tests/browser/";
const BLOCKED_PAGE = SUPPORT_FILES_PATH + "policy_websitefilter_block.html";
const EXCEPTION_PAGE =
  SUPPORT_FILES_PATH + "policy_websitefilter_exception.html";
const REDIRECT_301 = SUPPORT_FILES_PATH + "301.sjs";
const REDIRECT_302 = SUPPORT_FILES_PATH + "302.sjs";

const BLOCK_PATTERN = "*://mochi.test/*policy_websitefilter_*";
const EXCEPTION_PATTERN = "*://mochi.test/*_websitefilter_exception*";

// Checks whether loading |url| ends up on the blockedByPolicy error page.
async function isBlockedSite(url, isExpectedBlocked) {
  await BrowserTestUtils.withNewTab("about:blank", async browser => {
    let loaded = BrowserTestUtils.browserLoaded(browser, false, null, true);
    BrowserTestUtils.startLoadingURIString(browser, url);
    await loaded;
    let blocked = browser.documentURI.spec.startsWith(
      "about:neterror?e=blockedByPolicyEnterprise"
    );
    is(
      blocked,
      isExpectedBlocked,
      `${url} should ${isExpectedBlocked ? "" : "not "}be blocked by policy`
    );
  });
}

async function removePolicies() {
  await waitForLivePolicyUpdate({});
  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    {},
    "Expected no active policies after removal."
  );
}

// Blocking a redirect records enterprise telemetry into FOG.
registerCleanupFunction(() => Services.fog.testResetFOG());

// Applying the policy live blocks the configured pages (including redirects),
// and removing it live stops blocking them.
add_task(async function test_apply_then_remove() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        WebsiteFilter: {
          Block: [BLOCK_PATTERN],
        },
      },
    },
    null
  );

  await isBlockedSite(BLOCKED_PAGE, true);
  await isBlockedSite(REDIRECT_301, true);
  await isBlockedSite(REDIRECT_302, true);

  await removePolicies();

  await isBlockedSite(BLOCKED_PAGE, false);
  await isBlockedSite(REDIRECT_301, false);
  await isBlockedSite(REDIRECT_302, false);
});

// A live update tears the policy down and re-applies it which
// includes the removing and re-adding the redirect observer.
add_task(async function test_update_keeps_blocking_redirects() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        WebsiteFilter: {
          Block: [BLOCK_PATTERN],
        },
      },
    },
    null
  );

  await isBlockedSite(REDIRECT_301, true);

  // Change the parameters (add an unrelated exception) to trigger a
  // teardown-then-reapply update.
  await waitForLivePolicyUpdate({
    WebsiteFilter: {
      Block: [BLOCK_PATTERN],
      Exceptions: ["*://example.com/*"],
    },
  });

  await isBlockedSite(BLOCKED_PAGE, true);
  await isBlockedSite(REDIRECT_301, true);

  await removePolicies();
});

// A live update that changes the Block list drops the old pattern and applies
// the new one.
add_task(async function test_update_changes_block_list() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        WebsiteFilter: {
          Block: ["*://mochi.test/*_block*"],
        },
      },
    },
    null
  );

  await isBlockedSite(BLOCKED_PAGE, true);
  await isBlockedSite(EXCEPTION_PAGE, false);

  await waitForLivePolicyUpdate({
    WebsiteFilter: {
      Block: ["*://mochi.test/*_exception*"],
    },
  });

  // The old Block pattern no longer matches, the new one does.
  await isBlockedSite(BLOCKED_PAGE, false);
  await isBlockedSite(EXCEPTION_PAGE, true);

  await removePolicies();
});

// A live update that drops the exceptions must not leave any stale ones in place.
add_task(async function test_update_drops_exceptions() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        WebsiteFilter: {
          Block: [BLOCK_PATTERN],
          Exceptions: [EXCEPTION_PATTERN],
        },
      },
    },
    null
  );

  await isBlockedSite(BLOCKED_PAGE, true);
  await isBlockedSite(EXCEPTION_PAGE, false);

  // Drop the exceptions via a live update.
  await waitForLivePolicyUpdate({
    WebsiteFilter: {
      Block: [BLOCK_PATTERN],
    },
  });

  await isBlockedSite(BLOCKED_PAGE, true);
  await isBlockedSite(EXCEPTION_PAGE, true);

  await removePolicies();
});
