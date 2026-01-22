/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const SUPPORT_FILES_PATH =
  "http://mochi.test:8888/browser/browser/components/enterprisepolicies/tests/browser/";
const BLOCKED_PAGE = "policy_websitefilter_block.html";
const SAVELINKAS_PAGE = "policy_websitefilter_savelink.html";

async function clearWebsiteFilter() {
  await setupPolicyEngineWithJson({
    policies: {
      WebsiteFilter: {
        Block: [],
        Exceptions: [],
      },
    },
  });
}

add_task(async function test_policy_enterprise_telemetry() {
  await setupPolicyEngineWithJson({
    policies: {
      WebsiteFilter: `{
        "Block": ["*://mochi.test/*policy_websitefilter_block*"]
      }`,
    },
  });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.policies.enterprise.telemetry.testing.disableSubmit", true],
      [
        "browser.policies.enterprise.telemetry.blocklistDomainBrowsed.enabled",
        true,
      ],
      [
        "browser.policies.enterprise.telemetry.blocklistDomainBrowsed.urlLogging",
        "full",
      ],
    ],
  });

  const referrerURL = SUPPORT_FILES_PATH + SAVELINKAS_PAGE;
  const resolvedURL = SUPPORT_FILES_PATH + BLOCKED_PAGE;
  await checkBlockedPageTelemetry(SUPPORT_FILES_PATH + BLOCKED_PAGE);
  await checkBlockedPageTelemetry(SUPPORT_FILES_PATH + BLOCKED_PAGE, {
    referrerURL,
  });
  await checkBlockedPageTelemetry(
    "view-source:" + SUPPORT_FILES_PATH + BLOCKED_PAGE
  );
  await checkBlockedPageTelemetry(
    "about:reader?url=" + SUPPORT_FILES_PATH + BLOCKED_PAGE
  );

  await checkBlockedPageTelemetry(SUPPORT_FILES_PATH + "301.sjs", {
    resolvedURL,
  });
  await checkBlockedPageTelemetry(SUPPORT_FILES_PATH + "301.sjs", {
    resolvedURL,
    referrerURL,
  });

  await checkBlockedPageTelemetry(SUPPORT_FILES_PATH + "302.sjs", {
    resolvedURL,
  });
  await checkBlockedPageTelemetry(SUPPORT_FILES_PATH + "302.sjs", {
    resolvedURL,
    referrerURL,
  });

  await clearWebsiteFilter();
});

// Checks that a page was blocked by seeing if it was replaced with about:neterror
async function checkBlockedPageTelemetry(
  url,
  { resolvedURL, referrerURL } = {}
) {
  const expectedBlockedUrl = resolvedURL ?? url;

  let newTab;
  try {
    if (referrerURL) {
      newTab = await BrowserTestUtils.openNewForegroundTab(
        gBrowser,
        referrerURL
      );

      await SpecialPowers.spawn(newTab.linkedBrowser, [url], async href => {
        let link = content.document.getElementById("savelink_blocked");
        link.href = href;
      });
    } else {
      newTab = BrowserTestUtils.addTab(gBrowser);
      gBrowser.selectedTab = newTab;
    }
    let browser = newTab.linkedBrowser;

    let promise = BrowserTestUtils.waitForErrorPage(browser);
    if (referrerURL) {
      await BrowserTestUtils.synthesizeMouseAtCenter(
        "#savelink_blocked",
        {},
        browser
      );
    } else {
      BrowserTestUtils.startLoadingURIString(browser, url);
    }
    await promise;

    let events =
      Glean.contentPolicy.blocklistDomainBrowsed.testGetValue("enterprise");
    Assert.ok(events?.length, "Should have recorded events");
    if (!events?.length) {
      return;
    }
    Assert.greaterOrEqual(events.length, 1, "Should record at least one event"); // TODO this should eventually be exactly 1
    const event = events.at(-1);
    Assert.ok(event.extra, "Event should have extra data");
    Assert.equal(
      event.extra.url,
      expectedBlockedUrl,
      "Telemetry should include blocked URL"
    );
    if (resolvedURL) {
      Assert.equal(
        event.extra.original_url,
        url,
        "Telemetry should include original requested URL"
      );
    }
    if (referrerURL) {
      Assert.equal(
        event.extra.referrer,
        referrerURL,
        "Telemetry should include referrer URL"
      );
    }
  } finally {
    if (newTab) {
      BrowserTestUtils.removeTab(newTab);
    }
    Services.fog.testResetFOG();
  }
}
