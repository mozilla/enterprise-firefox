/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Maps each Safe Browsing threat type to a test URL that is added to the
// moztest lists in LookupCache.cpp / head.js.
const UNSAFE_SITES = [
  {
    threatType: "malware",
    url: "https://www.itisatrap.org/firefox/its-an-attack.html",
  },
  {
    threatType: "phishing",
    url: "https://www.itisatrap.org/firefox/its-a-trap.html",
  },
  {
    threatType: "unwanted",
    url: "https://www.itisatrap.org/firefox/unwanted.html",
  },
  {
    threatType: "harmful",
    url: "https://www.itisatrap.org/firefox/harmful.html",
  },
];

add_setup(async function () {
  await new Promise(resolve => waitForDBInit(resolve));
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
  for (const { threatType, url } of UNSAFE_SITES) {
    let tab = await loadUnsafeSite(url);
    try {
      let events = Glean.security.unsafeSiteVisit.testGetValue("enterprise");
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
        event.extra.threat_type,
        threatType,
        "Telemetry should include the threat type"
      );
      Assert.equal(
        typeof event.extra.provider,
        "string",
        "Telemetry should include a provider string"
      );
      Assert.equal(
        typeof event.extra.list,
        "string",
        "Telemetry should include a list string"
      );
    } finally {
      BrowserTestUtils.removeTab(tab);
      Services.fog.testResetFOG();
    }
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
    let events = Glean.security.unsafeSiteVisit.testGetValue("enterprise");
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
    let events = Glean.security.unsafeSiteVisit.testGetValue("enterprise");
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
    let events = Glean.security.unsafeSiteVisit.testGetValue("enterprise");
    Assert.ok(!events?.length, "Should not record when disabled");
  } finally {
    BrowserTestUtils.removeTab(tab);
    Services.fog.testResetFOG();
    await SpecialPowers.popPrefEnv();
  }
});
