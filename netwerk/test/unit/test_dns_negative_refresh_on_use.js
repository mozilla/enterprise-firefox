/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Verifies that negative A/AAAA DNS cache entries are served from cache for
// their TTL without an asynchronous re-resolution on every use (bug 2049178),
// and that network.dns.refresh_negative_addr_on_use restores the old
// refresh-on-use behavior.

/* import-globals-from head_trr.js */

var { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

let trrServer;

// A host that only has an A record, so the AAAA family resolves NODATA. This
// mirrors the common case in the bug: an IPv4-only host whose AAAA lookup is
// permanently negative.
const HOST = "negative-refresh.example.com";

add_setup(async function setup() {
  trr_test_setup();

  // Negative addr results are only reused (and thus eligible for the
  // refresh-on-use path) when Happy Eyeballs is enabled; otherwise high
  // priority negatives bypass the cache entirely (see
  // AddrHostRecord::HasUsableResultInternal).
  Services.prefs.setBoolPref("network.http.happy_eyeballs_enabled", true);

  trrServer = new TRRServer();
  await trrServer.start();
  Services.prefs.setCharPref(
    "network.trr.uri",
    `https://foo.example.com:${trrServer.port()}/dns-query`
  );
  Services.prefs.setIntPref("network.trr.mode", Ci.nsIDNSService.MODE_TRRONLY);

  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref("network.http.happy_eyeballs_enabled");
    Services.prefs.clearUserPref("network.dns.refresh_negative_addr_on_use");
    if (trrServer) {
      await trrServer.stop();
    }
    trr_clear_prefs();
  });
});

async function primeNegativeAAAA() {
  Services.dns.clearCache(true);
  await trrServer.execute("global.dns_query_counts = {}");
  await trrServer.registerDoHAnswers(HOST, "A", {
    answers: [
      { name: HOST, ttl: 55, type: "A", flush: false, data: "1.2.3.4" },
    ],
  });

  // Prime the negative AAAA cache entry with a single real query.
  let { inStatus } = await new TRRDNSListener(HOST, {
    flags: Ci.nsIDNSService.RESOLVE_DISABLE_IPV4,
    expectedSuccess: false,
  });
  Assert.equal(inStatus, Cr.NS_ERROR_UNKNOWN_HOST, "AAAA lookup is negative");
  Assert.equal(
    await trrServer.requestCount(HOST, "AAAA"),
    1,
    "the first lookup performs exactly one AAAA query"
  );
}

async function useNegativeAAAA(times) {
  for (let i = 0; i < times; i++) {
    await new TRRDNSListener(HOST, {
      flags: Ci.nsIDNSService.RESOLVE_DISABLE_IPV4,
      expectedSuccess: false,
    });
  }
  // Let any background re-resolution reach the server before we count.
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 500));
}

// Default behavior: the cached negative is reused without re-resolving.
add_task(async function default_does_not_refresh_negative_on_use() {
  await primeNegativeAAAA();
  await useNegativeAAAA(4);

  Assert.equal(
    await trrServer.requestCount(HOST, "AAAA"),
    1,
    "negative AAAA entry is served from cache without re-resolving on use"
  );
});

// With the pref set, each use kicks off a background re-resolution again.
add_task(async function pref_restores_refresh_on_use() {
  Services.prefs.setBoolPref("network.dns.refresh_negative_addr_on_use", true);
  await primeNegativeAAAA();
  await useNegativeAAAA(4);

  Assert.greater(
    await trrServer.requestCount(HOST, "AAAA"),
    1,
    "with the pref set, using a negative AAAA entry re-resolves in the background"
  );

  Services.prefs.clearUserPref("network.dns.refresh_negative_addr_on_use");
});
