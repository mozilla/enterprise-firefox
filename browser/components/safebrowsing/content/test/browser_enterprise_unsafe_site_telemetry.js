/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Maps each Safe Browsing threat type to a test URL that is added to the
// moztest lists in LookupCache.cpp / head.js, along with the moztest list that
// matches it. Test tables report the provider "test" (TESTING_TABLE_PROVIDER
// _NAME in nsUrlClassifierUtils).
const TEST_PROVIDER = "test";
const UNSAFE_SITES = [
  {
    threatType: "malware",
    url: "https://www.itisatrap.org/firefox/its-an-attack.html",
    list: "moztest-malware-simple",
  },
  {
    threatType: "phishing",
    url: "https://www.itisatrap.org/firefox/its-a-trap.html",
    list: "moztest-phish-simple",
  },
  {
    threatType: "unwanted",
    url: "https://www.itisatrap.org/firefox/unwanted.html",
    list: "moztest-unwanted-simple",
  },
  {
    threatType: "harmful",
    url: "https://www.itisatrap.org/firefox/harmful.html",
    list: "moztest-harmful-simple",
  },
];

// A real, safe top-level page (served over https) used as the embedder in the
// referrer test, so the blocked subframe load carries a deterministic referrer.
// The burst tests need one embedder per tab, on distinct origins, so that the
// referrer of a reported hit says which tab it came from.
function embedderUrl(origin) {
  return (
    getRootDirectory(gTestPath).replace("chrome://mochitests/content", origin) +
    "empty_file.html"
  );
}
const EMBEDDER_URL = embedderUrl("https://example.com");
const SECOND_EMBEDDER_URL = embedderUrl("https://example.org");

add_setup(async function () {
  await new Promise(resolve => waitForDBInit(resolve));
  Services.fog.testResetFOG();
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.safebrowsing.enterprise.telemetry.testing.disableSubmit", true],
      [
        "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.enabled",
        true,
      ],
      [
        "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.urlLogging",
        "full",
      ],
      // Classify subframes too, not just the top-level document, so the
      // subframe, referrer and burst tests below see Safe Browsing hits for
      // their iframes. Restored automatically at the end of this file.
      ["browser.safebrowsing.only_top_level", false],
    ],
  });
});

async function loadUnsafeSite(url) {
  let tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:blank"
  );
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, url);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url, true);
  return tab;
}

add_task(async function test_unsafe_site_visit_records_event() {
  for (const { threatType, url, list } of UNSAFE_SITES) {
    let tab = await loadUnsafeSite(url);
    try {
      let events = Glean.safebrowsing.siteVisit.testGetValue("enterprise");
      Assert.equal(
        events?.length,
        1,
        `Should record one event for ${threatType}`
      );
      const event = events.at(-1);
      Assert.ok(event.extra, "Event should have extra data");
      Assert.equal(
        event.extra.url,
        url,
        "Telemetry should include the blocked URL"
      );
      Assert.equal(
        event.extra.referrer,
        "",
        "A direct top-level load has no referrer"
      );
      Assert.equal(
        event.extra.threat_type,
        threatType,
        "Telemetry should include the threat type"
      );
      Assert.equal(
        event.extra.provider,
        TEST_PROVIDER,
        "Telemetry should include the Safe Browsing provider"
      );
      Assert.equal(
        event.extra.list,
        list,
        "Telemetry should include the matching Safe Browsing list"
      );
    } finally {
      BrowserTestUtils.removeTab(tab);
      Services.fog.testResetFOG();
    }
  }
});

add_task(async function test_records_for_subframe_load() {
  // A safe top-level page that embeds an unsafe iframe: the block is recorded
  // regardless of frame level, so a subframe load is reported like a top-level
  // one.
  const iframeUrl = UNSAFE_SITES[0].url;
  let tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html,<body></body>"
  );
  try {
    await SpecialPowers.spawn(tab.linkedBrowser, [iframeUrl], src => {
      let iframe = content.document.createElement("iframe");
      iframe.src = src;
      content.document.body.appendChild(iframe);
    });

    await TestUtils.waitForCondition(
      () => Glean.safebrowsing.siteVisit.testGetValue("enterprise")?.length,
      "Should record an event for the blocked subframe"
    );

    let events = Glean.safebrowsing.siteVisit.testGetValue("enterprise");
    Assert.equal(
      events.at(-1).extra.threat_type,
      "malware",
      "Subframe block should be recorded with the right threat type"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
    Services.fog.testResetFOG();
  }
});

add_task(async function test_records_referrer_of_embedder() {
  // The blocked resource alone does not tell an administrator which page pulled
  // it in. Load a safe page that embeds an unsafe iframe and confirm the
  // recorded event attributes the hit to that embedding page via the referrer.
  const iframeUrl = UNSAFE_SITES[0].url;
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, EMBEDDER_URL);
  try {
    await SpecialPowers.spawn(tab.linkedBrowser, [iframeUrl], src => {
      let iframe = content.document.createElement("iframe");
      iframe.src = src;
      content.document.body.appendChild(iframe);
    });

    await TestUtils.waitForCondition(
      () => Glean.safebrowsing.siteVisit.testGetValue("enterprise")?.length,
      "Should record an event for the blocked subframe"
    );

    let event = Glean.safebrowsing.siteVisit.testGetValue("enterprise").at(-1);
    Assert.equal(
      event.extra.url,
      iframeUrl,
      "The blocked subresource is still recorded as the url"
    );
    Assert.equal(
      event.extra.referrer,
      EMBEDDER_URL,
      "The embedding page is recorded as the referrer"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
    Services.fog.testResetFOG();
  }
});

add_task(async function test_referrer_redaction_domain() {
  // The referrer honours the same urlLogging policy as the url.
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.urlLogging",
        "domain",
      ],
    ],
  });

  const iframeUrl = UNSAFE_SITES[0].url;
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, EMBEDDER_URL);
  try {
    await SpecialPowers.spawn(tab.linkedBrowser, [iframeUrl], src => {
      let iframe = content.document.createElement("iframe");
      iframe.src = src;
      content.document.body.appendChild(iframe);
    });

    await TestUtils.waitForCondition(
      () => Glean.safebrowsing.siteVisit.testGetValue("enterprise")?.length,
      "Should record an event for the blocked subframe"
    );

    let event = Glean.safebrowsing.siteVisit.testGetValue("enterprise").at(-1);
    Assert.equal(
      event.extra.referrer,
      "example.com",
      "Only the referrer hostname is logged in domain mode"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
    Services.fog.testResetFOG();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_url_logging_domain() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.urlLogging",
        "domain",
      ],
    ],
  });

  let tab = await loadUnsafeSite(UNSAFE_SITES[0].url);
  try {
    let events = Glean.safebrowsing.siteVisit.testGetValue("enterprise");
    Assert.equal(events?.length, 1, "Should record one event");
    Assert.equal(
      events.at(-1).extra.url,
      "www.itisatrap.org",
      "Only the hostname should be logged in domain mode"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
    Services.fog.testResetFOG();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_url_logging_none() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.urlLogging",
        "none",
      ],
    ],
  });

  let tab = await loadUnsafeSite(UNSAFE_SITES[0].url);
  try {
    let events = Glean.safebrowsing.siteVisit.testGetValue("enterprise");
    Assert.equal(events?.length, 1, "Should record one event");
    Assert.equal(
      events.at(-1).extra.url,
      "",
      "No URL should be logged in none mode"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
    Services.fog.testResetFOG();
    await SpecialPowers.popPrefEnv();
  }
});

// Records the events every enterprise ping carried at submit time.
// testBeforeNextSubmit is a one-shot hook, so it re-arms itself after every
// submit: the assertions below need every submit counted, not just the first.
// The events have to be read inside the hook because submitting the ping clears
// them.
function recordEnterpriseSubmits() {
  const submits = [];
  function arm() {
    GleanPings.enterprise.testBeforeNextSubmit(() => {
      const events = Glean.safebrowsing.siteVisit.testGetValue("enterprise");
      submits.push(events?.map(event => event.extra.referrer) ?? []);
      arm();
    });
  }
  arm();

  return {
    // The referrer of every event reported across all pings, which says which
    // tab each hit came from. Counting these counts the hits that were
    // reported, however they were spread over pings.
    reportedReferrers: () => submits.flat(),
    // Overwrite the pending one-shot hook with a no-op so it does not stay armed
    // for later tests.
    disarm: () => GleanPings.enterprise.testBeforeNextSubmit(() => {}),
  };
}

// Appends an unsafe iframe per url, all before any of them is classified, so the
// hits arrive as one burst.
async function burstUnsafeIframes(browser, urls) {
  await SpecialPowers.spawn(browser, [urls], srcs => {
    for (const src of srcs) {
      const iframe = content.document.createElement("iframe");
      iframe.src = src;
      content.document.body.appendChild(iframe);
    }
  });
}

// Resolves once every subframe of browser has been replaced by about:blocked,
// i.e. once Safe Browsing has classified the whole burst.
async function waitForBlockedSubframes(browser, expectedCount) {
  await TestUtils.waitForCondition(() => {
    const frames = browser.browsingContext.children;
    return (
      frames.length === expectedCount &&
      frames.every(frame =>
        frame.currentWindowGlobal?.documentURI?.spec.startsWith("about:blocked")
      )
    );
  }, `All ${expectedCount} unsafe subframes are blocked`);
}

add_task(async function test_burst_in_one_tab_reports_every_hit() {
  // One page load that trips Safe Browsing several times over, here through
  // several unsafe subframes classified at once. Every hit of the burst is
  // reported, so the load costs one ping and one event per hit.
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.safebrowsing.enterprise.telemetry.testing.disableSubmit",
        false,
      ],
    ],
  });

  const recorder = recordEnterpriseSubmits();
  const burstUrls = UNSAFE_SITES.map(site => site.url);

  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, EMBEDDER_URL);
  try {
    await burstUnsafeIframes(tab.linkedBrowser, burstUrls);
    await waitForBlockedSubframes(tab.linkedBrowser, burstUrls.length);

    await TestUtils.waitForCondition(
      () => recorder.reportedReferrers().length >= burstUrls.length,
      "Every hit of the burst is reported"
    );
    Assert.deepEqual(
      recorder.reportedReferrers(),
      burstUrls.map(() => EMBEDDER_URL),
      "The burst reports one event per hit, all attributed to the embedding page"
    );
  } finally {
    recorder.disarm();
    BrowserTestUtils.removeTab(tab);
    Services.fog.testResetFOG();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_simultaneous_bursts_in_two_tabs() {
  // Two tabs each load several unsafe subframes at once, with both bursts in
  // flight together, so the order the hits arrive in is not fixed. Every hit is
  // still reported, and each one is attributed to the tab whose load produced
  // it rather than to whichever tab happens to be selected.
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.safebrowsing.enterprise.telemetry.testing.disableSubmit",
        false,
      ],
    ],
  });

  const recorder = recordEnterpriseSubmits();
  const burstUrls = UNSAFE_SITES.map(site => site.url);
  const embedders = [EMBEDDER_URL, SECOND_EMBEDDER_URL];
  const expectedReferrers = embedders
    .flatMap(embedder => burstUrls.map(() => embedder))
    .sort();

  let tabs = embedders.map(url => BrowserTestUtils.addTab(gBrowser, url));
  try {
    await Promise.all(
      tabs.map((tab, i) =>
        BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, embedders[i])
      )
    );

    await Promise.all(
      tabs.map(tab => burstUnsafeIframes(tab.linkedBrowser, burstUrls))
    );
    await Promise.all(
      tabs.map(tab =>
        waitForBlockedSubframes(tab.linkedBrowser, burstUrls.length)
      )
    );

    await TestUtils.waitForCondition(
      () => recorder.reportedReferrers().length >= expectedReferrers.length,
      "Every hit of both bursts is reported"
    );
    Assert.deepEqual(
      recorder.reportedReferrers().sort(),
      expectedReferrers,
      "Both bursts report one event per hit, attributed to their own tab"
    );
  } finally {
    recorder.disarm();
    for (const tab of tabs) {
      BrowserTestUtils.removeTab(tab);
    }
    Services.fog.testResetFOG();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_disabled_records_nothing() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.enabled",
        false,
      ],
    ],
  });

  let tab = await loadUnsafeSite(UNSAFE_SITES[0].url);
  try {
    let events = Glean.safebrowsing.siteVisit.testGetValue("enterprise");
    Assert.ok(!events?.length, "Should not record when disabled");
  } finally {
    BrowserTestUtils.removeTab(tab);
    Services.fog.testResetFOG();
    await SpecialPowers.popPrefEnv();
  }
});
