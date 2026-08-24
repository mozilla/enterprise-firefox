/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Extract the site URI (scheme + eTLD+1) that SitePolicies match patterns are
// keyed on.
function siteURI(url) {
  let uri = Services.io.newURI(url);
  return Services.io.newURI(
    Services.scriptSecurityManager.createContentPrincipal(uri, {})
      .siteOriginNoSuffix
  );
}

function assertJitAllowed(url, isAllowed) {
  Assert.equal(
    Services.policies.isAllowedForURI("jit", siteURI(url)),
    isAllowed,
    `JIT should be ${isAllowed ? "allowed" : "disallowed"} for ${url}`
  );
}

function assertHasSitePolicy(url, expected) {
  Assert.equal(
    Services.policies.hasSitePoliciesForURI(Services.io.newURI(url)),
    expected,
    `hasSitePoliciesForURI should return ${expected} for ${url}`
  );
}

// Assert the site-policy shared data in parent and content
async function assertSitePolicyCount(urls, expected) {
  let shared = Services.ppmm.sharedData.get("EnterprisePolicies:SitePolicies");
  Assert.equal(
    shared?.length ?? 0,
    expected,
    `Parent should hold ${expected} site policies`
  );

  // updateSitePolicies stages the shared data change but relies on an idle
  // flush to reach content.
  Services.ppmm.sharedData.flush();

  for (let url of urls) {
    await BrowserTestUtils.withNewTab(url, browser =>
      SpecialPowers.spawn(browser, [expected, url], async (count, tabUrl) => {
        const { ContentTaskUtils } = ChromeUtils.importESModule(
          "resource://testing-common/ContentTaskUtils.sys.mjs"
        );
        await ContentTaskUtils.waitForCondition(() => {
          let contentShared = Services.cpmm.sharedData.get(
            "EnterprisePolicies:SitePolicies"
          );
          return (contentShared?.length ?? 0) === count;
        }, `Content process for ${tabUrl} should see ${count} site policies`);
      })
    );
  }
}

async function assertNoSitePolicies() {
  assertHasSitePolicy("https://example.com/", false);
  assertHasSitePolicy("https://example.org/", false);
  assertJitAllowed("https://example.com/", true);
  assertJitAllowed("https://example.org/", true);
  await assertSitePolicyCount(
    ["https://example.com/", "https://example.org/"],
    0
  );
}

add_task(async function test_apply_then_remove_sitepolicies() {
  await assertNoSitePolicies();

  info("Applying SitePolicies remotely.");
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        SitePolicies: [
          {
            Match: ["*.example.com"],
            Policies: { DisableJit: true },
          },
        ],
      },
    },
    null
  );

  assertHasSitePolicy("https://example.com/", true);
  assertHasSitePolicy("https://example.org/", false);
  assertJitAllowed("https://example.com/", false);
  assertJitAllowed("https://example.org/", true);
  await assertSitePolicyCount(
    ["https://example.com/", "https://example.org/"],
    1
  );

  info("Removing SitePolicies.");
  await waitForLivePolicyUpdate({});

  // onRemove must reset both the parent's internal state and
  // the shared data snapshot read by content processes.
  await assertNoSitePolicies();
});

add_task(async function test_apply_then_update_sitepolicies() {
  await assertNoSitePolicies();

  info("Applying SitePolicies matching example.com.");
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        SitePolicies: [
          {
            Match: ["*.example.com"],
            Policies: { DisableJit: true },
          },
        ],
      },
    },
    null
  );

  assertJitAllowed("https://example.com/", false);
  assertJitAllowed("https://example.org/", true);
  await assertSitePolicyCount(
    ["https://example.com/", "https://example.org/"],
    1
  );

  info("Updating SitePolicies to match example.org instead.");
  await waitForLivePolicyUpdate({
    SitePolicies: [
      {
        Match: ["*.example.org"],
        Policies: { DisableJit: true },
      },
    ],
  });

  assertHasSitePolicy("https://example.com/", false);
  assertHasSitePolicy("https://example.org/", true);
  assertJitAllowed("https://example.com/", true);
  assertJitAllowed("https://example.org/", false);
  await assertSitePolicyCount(
    ["https://example.com/", "https://example.org/"],
    1
  );

  info("Removing SitePolicies.");
  await waitForLivePolicyUpdate({});

  await assertNoSitePolicies();
});

add_task(async function test_live_update_exceptions() {
  await assertNoSitePolicies();

  info("Applying an Exceptions-based SitePolicies remotely.");
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        SitePolicies: [
          {
            Exceptions: ["*.example.com"],
            Policies: { DisableJit: true },
          },
        ],
      },
    },
    null
  );

  await assertSitePolicyCount(
    ["https://example.com/", "https://example.org/"],
    1
  );
  assertJitAllowed("https://example.com/", true);

  info("Updating the exception to example.org so the diff re-applies it.");
  await waitForLivePolicyUpdate({
    SitePolicies: [
      {
        Exceptions: ["*.example.org"],
        Policies: { DisableJit: true },
      },
    ],
  });

  await assertSitePolicyCount(
    ["https://example.com/", "https://example.org/"],
    1
  );
  assertJitAllowed("https://example.com/", false);
  assertJitAllowed("https://example.org/", true);

  info("Removing SitePolicies.");
  await waitForLivePolicyUpdate({});

  await assertNoSitePolicies();
});
