/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for the enterprise "unsafe download" security telemetry recorded when
 * download protection flags a download as unsafe.
 *
 * These tests only run in MOZ_ENTERPRISE builds, where the safebrowsing.download
 * event exists. The manifest (xpcshell.toml) uses run-if = ["enterprise"].
 */

"use strict";

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const { EnterprisePingCollector } = ChromeUtils.importESModule(
  "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
);

const gAppRep = Cc[
  "@mozilla.org/reputationservice/application-reputation-service;1"
].getService(Ci.nsIApplicationReputationService);

const appRepURLPref = "browser.safebrowsing.downloads.remote.url";

// This URI's hash is contained in data/block_digest.chunk, so a lookup matches
// the local download block list and produces a VERDICT_DANGEROUS verdict
// without any remote request.
const blocklistedURI = createURI("http://baz:qux@blocklisted.com?xyzzy");

let gHttpServ = null;
let gTables = {};

function readFileToString(aFilename) {
  let f = do_get_file(aFilename);
  let stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
    Ci.nsIFileInputStream
  );
  stream.init(f, -1, 0, 0);
  let buf = NetUtil.readInputStreamToString(stream, stream.available());
  return buf;
}

function registerTableUpdate(aTable, aFilename) {
  if (!(aTable in gTables)) {
    gTables[aTable] = [];
  }
  let numChunks = gTables[aTable].length + 1;
  let redirectPath = "/" + aTable + "-" + numChunks;
  let redirectUrl = "localhost:4444" + redirectPath;
  gTables[aTable].push(redirectUrl);

  gHttpServ.registerPathHandler(redirectPath, function (request, response) {
    let contents = readFileToString(aFilename);
    response.setHeader(
      "Content-Type",
      "application/vnd.google.safebrowsing-update",
      false
    );
    response.setStatusLine(request.httpVersion, 200, "OK");
    response.bodyOutputStream.write(contents, contents.length);
  });
}

function queryReputation(aQuery) {
  return new Promise(resolve => {
    gAppRep.queryReputation(aQuery, (aShouldBlock, aStatus, aVerdict) => {
      resolve({
        shouldBlock: aShouldBlock,
        status: aStatus,
        verdict: aVerdict,
      });
    });
  });
}

function collectUnsafeDownloads() {
  return new EnterprisePingCollector(Glean.safebrowsing.download);
}

add_setup(async function setup() {
  Services.fog.initializeFOG();

  // Route download protection at a local server and enable safe browsing.
  Services.prefs.setCharPref(appRepURLPref, "http://localhost:4444/download");
  Services.prefs.setBoolPref("browser.safebrowsing.malware.enabled", true);
  Services.prefs.setBoolPref("browser.safebrowsing.downloads.enabled", true);
  Services.prefs.setCharPref(
    "urlclassifier.downloadBlockTable",
    "goog-badbinurl-shavar"
  );
  registerCleanupFunction(function () {
    Services.prefs.clearUserPref("browser.safebrowsing.malware.enabled");
    Services.prefs.clearUserPref("browser.safebrowsing.downloads.enabled");
    Services.prefs.clearUserPref("urlclassifier.downloadBlockTable");
    Services.prefs.clearUserPref(appRepURLPref);
  });

  Services.prefs.setBoolPref(
    "browser.safebrowsing.enterprise.telemetry.unsafeDownload.enabled",
    true
  );
  Services.prefs.setCharPref(
    "browser.safebrowsing.enterprise.telemetry.unsafeDownload.urlLogging",
    "full"
  );
  registerCleanupFunction(function () {
    Services.prefs.clearUserPref(
      "browser.safebrowsing.enterprise.telemetry.unsafeDownload.enabled"
    );
    Services.prefs.clearUserPref(
      "browser.safebrowsing.enterprise.telemetry.unsafeDownload.urlLogging"
    );
  });

  gHttpServ = new HttpServer();
  gHttpServ.registerDirectory("/", do_get_cwd());
  gHttpServ.registerPathHandler("/download", function () {
    do_throw("Local block list hits must not make a remote lookup");
  });
  gHttpServ.registerPathHandler("/downloads", function (request, response) {
    let blob = "n:1000\n";
    for (let table in gTables) {
      blob += "i:" + table + "\n";
      for (let i = 0; i < gTables[table].length; ++i) {
        blob += "u:" + gTables[table][i] + "\n";
      }
    }
    response.setHeader(
      "Content-Type",
      "application/vnd.google.safebrowsing-update",
      false
    );
    response.setStatusLine(request.httpVersion, 200, "OK");
    response.bodyOutputStream.write(blob, blob.length);
  });
  gHttpServ.start(4444);
  registerCleanupFunction(
    () => new Promise(resolve => gHttpServ.stop(resolve))
  );

  // Populate the local block list with the hash of blocklisted.com/.
  registerTableUpdate("goog-badbinurl-shavar", "data/block_digest.chunk");
  let streamUpdater = Cc[
    "@mozilla.org/url-classifier/streamupdater;1"
  ].getService(Ci.nsIUrlClassifierStreamUpdater);
  await new Promise((resolve, reject) => {
    streamUpdater.downloadUpdates(
      "goog-badbinurl-shavar",
      "goog-badbinurl-shavar;\n",
      "",
      true,
      "test",
      "http://localhost:4444/downloads",
      resolve,
      reject,
      reject
    );
  });

  Services.fog.testResetFOG();
});

add_task(async function test_records_dangerous_download() {
  using collector = collectUnsafeDownloads();
  try {
    let { shouldBlock, status } = await queryReputation({
      sourceURI: blocklistedURI,
      fileSize: 12,
    });
    Assert.equal(status, Cr.NS_OK, "Query should succeed");
    Assert.ok(shouldBlock, "Blocklisted download should be blocked");

    const events = collector.events;
    Assert.equal(events.length, 1, "Should record one unsafe download event");
    const event = events.at(-1);
    Assert.ok(event.extra, "Event should have extra data");
    Assert.equal(
      event.extra.verdict,
      "dangerous",
      "Local block list hit is reported as a dangerous verdict"
    );
    Assert.ok(
      event.extra.url.includes("blocklisted.com"),
      `Full URL should be logged, got ${event.extra.url}`
    );
    Assert.ok(
      !event.extra.url.includes("qux") && event.extra.url.includes("****"),
      `The password must be masked in the logged URL, got ${event.extra.url}`
    );
  } finally {
    Services.fog.testResetFOG();
  }
});

add_task(async function test_url_logging_domain() {
  Services.prefs.setCharPref(
    "browser.safebrowsing.enterprise.telemetry.unsafeDownload.urlLogging",
    "domain"
  );
  using collector = collectUnsafeDownloads();
  try {
    let { shouldBlock } = await queryReputation({
      sourceURI: blocklistedURI,
      fileSize: 12,
    });
    Assert.ok(shouldBlock, "Blocklisted download should be blocked");

    const events = collector.events;
    Assert.equal(events.length, 1, "Should record one event");
    Assert.equal(
      events.at(-1).extra.url,
      "blocklisted.com",
      "Only the hostname should be logged in domain mode"
    );
  } finally {
    Services.prefs.setCharPref(
      "browser.safebrowsing.enterprise.telemetry.unsafeDownload.urlLogging",
      "full"
    );
    Services.fog.testResetFOG();
  }
});

add_task(async function test_url_logging_none() {
  Services.prefs.setCharPref(
    "browser.safebrowsing.enterprise.telemetry.unsafeDownload.urlLogging",
    "none"
  );
  using collector = collectUnsafeDownloads();
  try {
    let { shouldBlock } = await queryReputation({
      sourceURI: blocklistedURI,
      fileSize: 12,
    });
    Assert.ok(shouldBlock, "Blocklisted download should be blocked");

    const events = collector.events;
    Assert.equal(events.length, 1, "Should record one event");
    Assert.equal(
      events.at(-1).extra.url,
      "",
      "No URL should be logged in none mode"
    );
  } finally {
    Services.prefs.setCharPref(
      "browser.safebrowsing.enterprise.telemetry.unsafeDownload.urlLogging",
      "full"
    );
    Services.fog.testResetFOG();
  }
});

add_task(async function test_every_detection_submits_a_ping() {
  // Every unsafe verdict submits its own ping, even back to back.
  using collector = collectUnsafeDownloads();
  try {
    for (const attempt of [1, 2]) {
      let { shouldBlock } = await queryReputation({
        sourceURI: blocklistedURI,
        fileSize: 12,
      });
      Assert.ok(shouldBlock, `Download ${attempt} should be blocked`);
      Assert.equal(
        collector.submitCount,
        attempt,
        `Download ${attempt} submits its own enterprise ping`
      );
    }
  } finally {
    Services.fog.testResetFOG();
  }
});

add_task(async function test_default_records_nothing() {
  Services.prefs.clearUserPref(
    "browser.safebrowsing.enterprise.telemetry.unsafeDownload.enabled"
  );
  using collector = collectUnsafeDownloads();
  try {
    let { shouldBlock } = await queryReputation({
      sourceURI: blocklistedURI,
      fileSize: 12,
    });
    Assert.ok(shouldBlock, "Download is still blocked without the policy");
    collector.assertNothingRecorded(
      "Should not record without an enabling policy"
    );
  } finally {
    Services.fog.testResetFOG();
  }
});

add_task(async function test_disabled_records_nothing() {
  Services.prefs.setBoolPref(
    "browser.safebrowsing.enterprise.telemetry.unsafeDownload.enabled",
    false
  );
  using collector = collectUnsafeDownloads();
  try {
    let { shouldBlock } = await queryReputation({
      sourceURI: blocklistedURI,
      fileSize: 12,
    });
    Assert.ok(shouldBlock, "Download is still blocked when telemetry is off");
    collector.assertNothingRecorded("Should not record when disabled");
  } finally {
    Services.prefs.setBoolPref(
      "browser.safebrowsing.enterprise.telemetry.unsafeDownload.enabled",
      true
    );
    Services.fog.testResetFOG();
  }
});

add_task(async function test_removed_testing_pref_is_inert() {
  // The pref that once let tests turn submission off must not affect it.
  Services.prefs.setBoolPref(
    "browser.safebrowsing.enterprise.telemetry.testing.disableSubmit",
    true
  );
  using collector = collectUnsafeDownloads();
  try {
    let { shouldBlock } = await queryReputation({
      sourceURI: blocklistedURI,
      fileSize: 12,
    });
    Assert.ok(shouldBlock, "Blocklisted download should be blocked");
    Assert.equal(
      collector.submitCount,
      1,
      "The ping is submitted regardless of the pref"
    );
  } finally {
    Services.prefs.clearUserPref(
      "browser.safebrowsing.enterprise.telemetry.testing.disableSubmit"
    );
    Services.fog.testResetFOG();
  }
});
