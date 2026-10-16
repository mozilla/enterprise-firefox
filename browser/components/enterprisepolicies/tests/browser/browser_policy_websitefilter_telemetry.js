/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const { EnterprisePingCollector } = ChromeUtils.importESModule(
  "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
);

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
      SecurityLogging: {
        BlocklistDomainBrowsed: { Enabled: true, UrlLogging: "full" },
      },
    },
  });

  const referrerURL = SUPPORT_FILES_PATH + SAVELINKAS_PAGE;
  const resolvedURL = SUPPORT_FILES_PATH + BLOCKED_PAGE;
  // A different URL for the linked load: the recorder skips a URL it blocked
  // within the last second.
  const linkedURL = SUPPORT_FILES_PATH + BLOCKED_PAGE + "?linked";
  await checkBlockedPageTelemetry(SUPPORT_FILES_PATH + BLOCKED_PAGE);
  await checkBlockedPageTelemetry(linkedURL, { referrerURL });
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

add_task(async function test_no_telemetry_without_security_logging_policy() {
  await setupPolicyEngineWithJson({
    policies: {
      WebsiteFilter: `{
        "Block": ["*://mochi.test/*policy_websitefilter_block*"]
      }`,
    },
  });

  try {
    // A direct load is blocked before it starts and a redirect once its
    // response arrives, each by a different recorder; neither records anything
    // without the SecurityLogging policy.
    for (const page of [BLOCKED_PAGE, "301.sjs"]) {
      using collector = collectBlockedPages();
      const newTab = BrowserTestUtils.addTab(gBrowser);
      gBrowser.selectedTab = newTab;
      try {
        const browser = newTab.linkedBrowser;
        const errorPage = BrowserTestUtils.waitForErrorPage(browser);
        BrowserTestUtils.startLoadingURIString(
          browser,
          SUPPORT_FILES_PATH + page
        );
        await errorPage;

        collector.assertNothingRecorded(
          `Blocking ${page} records nothing without the SecurityLogging policy`
        );
      } finally {
        BrowserTestUtils.removeTab(newTab);
        Services.fog.testResetFOG();
      }
    }
  } finally {
    await clearWebsiteFilter();
  }
});

function collectBlockedPages() {
  return new EnterprisePingCollector(
    Glean.contentPolicy.blocklistDomainBrowsed
  );
}

// Loads url (through a link on referrerURL when given), checks that it was
// blocked, i.e. replaced with about:neterror, and checks the
// blocklistDomainBrowsed event the block recorded.
async function checkBlockedPageTelemetry(
  url,
  { resolvedURL, referrerURL } = {}
) {
  const expectedBlockedUrl = resolvedURL ?? url;

  using collector = collectBlockedPages();
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

    const events = collector.events;
    Assert.ok(events.length, "Should have recorded events");
    if (!events.length) {
      return;
    }
    Assert.equal(events.length, 1, "Should record exactly one event");
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
