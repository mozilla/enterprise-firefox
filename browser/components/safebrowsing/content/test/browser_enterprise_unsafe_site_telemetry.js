/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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

add_task(async function test_records_for_subframe_load() {
  // A safe top-level page that embeds an unsafe iframe. The old about:blocked
  // hook only reported top-level blocks, so this produced no telemetry; the
  // classifier-level hook records it regardless of frame level.
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

    await BrowserTestUtils.waitForCondition(
      () => Glean.security.unsafeSiteVisit.testGetValue("enterprise")?.length,
      "Should record an event for the blocked subframe"
    );

    let events = Glean.security.unsafeSiteVisit.testGetValue("enterprise");
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

add_task(async function test_burst_submits_once_then_throttles() {
  // A page load that triggers several Safe Browsing hits at once (multiple
  // unsafe subframes) should submit the enterprise ping immediately on the
  // first hit and then drop every further ping for the duration of the cooldown
  // window, rather than emitting one ping per hit. Every hit is still recorded
  // as its own event.
  const iframeUrls = UNSAFE_SITES.map(s => s.url);

  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.safebrowsing.enterprise.telemetry.testing.disableSubmit",
        false,
      ],
      [
        "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.submitCooldownMs",
        5000,
      ],
    ],
  });

  let submitCount = 0;
  let eventsAtFirstSubmit = 0;
  function registerHook() {
    GleanPings.enterprise.testBeforeNextSubmit(() => {
      submitCount++;
      if (submitCount === 1) {
        eventsAtFirstSubmit =
          Glean.security.unsafeSiteVisit.testGetValue("enterprise")?.length ??
          0;
      }
      registerHook();
    });
  }
  registerHook();

  let tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html,<body></body>"
  );
  try {
    await SpecialPowers.spawn(tab.linkedBrowser, [iframeUrls], srcs => {
      for (const src of srcs) {
        let iframe = content.document.createElement("iframe");
        iframe.src = src;
        content.document.body.appendChild(iframe);
      }
    });

    await BrowserTestUtils.waitForCondition(
      () => submitCount >= 1,
      "The enterprise ping should be submitted immediately on the first hit",
      200,
      100
    );

    // The first ping fires synchronously on the first hit, so only that hit's
    // event is staged at submit time.
    Assert.equal(
      eventsAtFirstSubmit,
      1,
      "The immediately-submitted ping carries only the first hit's event"
    );

    // Wait for the rest of the burst to be recorded, then confirm no extra ping
    // was submitted during the cooldown window.
    await BrowserTestUtils.waitForCondition(
      () =>
        (Glean.security.unsafeSiteVisit.testGetValue("enterprise")?.length ??
          0) === iframeUrls.length,
      "Every hit in the burst should be recorded as an event",
      200,
      100
    );

    Assert.equal(
      submitCount,
      1,
      "Further hits during the cooldown must not submit additional pings"
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
