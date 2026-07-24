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
const EMBEDDER_URL =
  getRootDirectory(gTestPath).replace(
    "chrome://mochitests/content",
    "https://example.com"
  ) + "empty_file.html";

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
      // subframe and burst tests below see Safe Browsing hits for their
      // iframes. Restored automatically at the end of this file.
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

// Navigates a browser to an unsafe URL and resolves once the (about:blocked)
// load has finished, i.e. once Safe Browsing classification has definitely run.
async function loadUnsafeInto(browser, url) {
  BrowserTestUtils.startLoadingURIString(browser, url);
  await BrowserTestUtils.browserLoaded(browser, false, url, true);
}

add_task(async function test_cooldown_is_per_tab() {
  // The enterprise ping is throttled so that repeated Safe Browsing hits do not
  // produce one ping per hit. The throttle is keyed on the originating tab:
  // hits from the same tab inside the cooldown window are dropped entirely (not
  // recorded), while a hit from a different tab is always reported even inside
  // the window. The cooldown is set far longer than the test so both branches
  // are exercised deterministically within a single window.
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.safebrowsing.enterprise.telemetry.testing.disableSubmit",
        false,
      ],
      ["browser.safebrowsing.enterprise.telemetry.submitCooldownMs", 60000],
    ],
  });

  // This test expects two submits: one from the first hit, one from the
  // different tab. Re-arm the hook only while more are expected so we don't
  // leave a dangling testBeforeNextSubmit callback that fires in later tests.
  const EXPECTED_SUBMITS = 2;
  let submitCount = 0;
  let eventsAtFirstSubmit = 0;
  function registerHook() {
    GleanPings.enterprise.testBeforeNextSubmit(() => {
      submitCount++;
      if (submitCount === 1) {
        eventsAtFirstSubmit =
          Glean.safebrowsing.siteVisit.testGetValue("enterprise")?.length ?? 0;
      }
      if (submitCount < EXPECTED_SUBMITS) {
        registerHook();
      }
    });
  }
  registerHook();

  let tab1 = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:blank"
  );
  let tab2;
  try {
    // First hit in tab1: submitted immediately, carrying only its own event.
    await loadUnsafeInto(tab1.linkedBrowser, UNSAFE_SITES[0].url);
    await TestUtils.waitForCondition(
      () => submitCount >= 1,
      "The first hit submits the enterprise ping immediately"
    );
    Assert.equal(
      eventsAtFirstSubmit,
      1,
      "The immediately-submitted ping carries only the first hit's event"
    );

    // A second hit in the same tab, inside the cooldown window, is dropped and
    // never recorded, so nothing is left staged behind the submitted ping.
    await loadUnsafeInto(tab1.linkedBrowser, UNSAFE_SITES[1].url);
    Assert.equal(
      submitCount,
      1,
      "A same-tab hit inside the cooldown must not submit a further ping"
    );
    Assert.ok(
      !Glean.safebrowsing.siteVisit.testGetValue("enterprise"),
      "The dropped same-tab hit is not recorded"
    );

    // A hit from a different tab, still inside the cooldown window, is always
    // reported: the throttle only collapses hits within a single tab.
    tab2 = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
    await loadUnsafeInto(tab2.linkedBrowser, UNSAFE_SITES[0].url);
    await TestUtils.waitForCondition(
      () => submitCount >= 2,
      "A hit from a different tab bypasses the cooldown and submits a ping"
    );
    Assert.equal(
      submitCount,
      2,
      "A different tab's hit submits its own ping inside the cooldown window"
    );
  } finally {
    // Overwrite any pending one-shot hook with a no-op so a failure path that
    // exited before the expected submits does not leave a callback armed for
    // later tests.
    GleanPings.enterprise.testBeforeNextSubmit(() => {});
    BrowserTestUtils.removeTab(tab1);
    if (tab2) {
      BrowserTestUtils.removeTab(tab2);
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
