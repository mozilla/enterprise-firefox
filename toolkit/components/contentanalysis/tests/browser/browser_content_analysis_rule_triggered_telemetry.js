/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// This test only runs in MOZ_ENTERPRISE builds (see browser.toml), since
// the content_analysis.rule_triggered Glean event and the
// ContentAnalysisTelemetry enterprise policy prefs it's gated by don't
// exist otherwise.

let mockCA = makeMockContentAnalysis();

add_setup(async function test_setup() {
  mockCA = await mockContentAnalysisService(mockCA);
  // Each recordRuleTriggered() call submits the "enterprise" ping
  // immediately, which clears its buffered events. Disable that here so
  // testGetValue() can see every event recorded during a test, including
  // cases (like a warn verdict followed by its resolution) where more than
  // one event is recorded per test.
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.contentanalysis.enterprise.telemetry.testing.disableSubmit",
        true,
      ],
    ],
  });
});

const testPage =
  "<body style='margin: 0'><input id='input' type='text'></body>";

const CLIPBOARD_TEXT_STRING = "Just some text";

const TEST_PAGE_URL =
  "https://example.com/browser/toolkit/components/contentanalysis/tests/browser/";

function setClipboardData(clipboardString) {
  const trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(
    Ci.nsITransferable
  );
  trans.init(null);
  trans.addDataFlavor("text/plain");
  const str = Cc["@mozilla.org/supports-string;1"].createInstance(
    Ci.nsISupportsString
  );
  str.data = clipboardString;
  trans.setTransferData("text/plain", str);

  Services.clipboard.setData(trans, null, Ci.nsIClipboard.kGlobalClipboard);
}

async function pasteAndGetTelemetryEvents({ allow, useDataUrl = true }) {
  mockCA.setupForTest(allow, /* waitForEvent */ false, /* showDialogs */ true);
  Services.fog.testResetFOG();

  let tab = BrowserTestUtils.addTab(gBrowser);
  let browser = gBrowser.getBrowserForTab(tab);
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.loadURIString({
    browser: tab.linkedBrowser,
    uriString: useDataUrl
      ? "data:text/html," + escape(testPage)
      : TEST_PAGE_URL,
  });
  await SimpleTest.promiseFocus(browser);

  setClipboardData(CLIPBOARD_TEXT_STRING);

  await SpecialPowers.spawn(
    browser,
    [testPage, useDataUrl],
    (html, isDataUrl) => {
      if (!isDataUrl) {
        content.document.body.innerHTML = html;
      }
      content.document.getElementById("input").value = "";
      content.document.getElementById("input").focus();
    }
  );

  let blockDialogPromise;
  if (!allow) {
    blockDialogPromise = BrowserTestUtils.promiseAlertDialogOpen();
  }

  await BrowserTestUtils.synthesizeKey("v", { accelKey: true }, browser);
  if (!allow) {
    let win = await blockDialogPromise;
    win.document.querySelector("dialog").getButton("accept").click();
  }

  BrowserTestUtils.removeTab(tab);

  return Glean.contentAnalysis.ruleTriggered.testGetValue("enterprise");
}

add_task(async function testBlockVerdictRecordsTelemetryByDefault() {
  const events = await pasteAndGetTelemetryEvents({ allow: false });
  ok(events, "should have recorded rule_triggered telemetry for a block");
  is(events.length, 1, "should record exactly one event");
  is(events[0].extra.operation, "clipboard");
  is(events[0].extra.action, "block");
  is(events[0].extra.type, "verdict");
  is(events[0].extra.analysis_type, "BULK_DATA_ENTRY");
  is(events[0].extra.reason, "CLIPBOARD_PASTE");
  is(
    events[0].extra.is_builtin,
    "false",
    "is_builtin should be false since these tests use an external agent"
  );
  is(
    events[0].extra.cancel_error,
    "",
    "cancel_error should be unset for a verdict from an agent"
  );
  is(events[0].extra.is_cached, "false");
});

add_task(async function testAllowVerdictDoesNotRecordTelemetryByDefault() {
  const events = await pasteAndGetTelemetryEvents({ allow: true });
  is(
    events,
    null,
    "should not record rule_triggered telemetry for an allow verdict when RecordEvents is nonAllow (default)"
  );
});

add_task(async function testAllowVerdictRecordsTelemetryWhenPolicyIsAll() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.contentanalysis.enterprise.telemetry.recordEvents", "all"]],
  });
  const events = await pasteAndGetTelemetryEvents({ allow: true });
  ok(
    events,
    "should record rule_triggered telemetry for an allow verdict when RecordEvents is all"
  );
  is(events[0].extra.action, "allow");
  await SpecialPowers.popPrefEnv();
});

add_task(async function testUrlLoggingPolicyNone() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.contentanalysis.enterprise.telemetry.urlLogging", "none"]],
  });
  const events = await pasteAndGetTelemetryEvents({
    allow: false,
    useDataUrl: false,
  });
  ok(events, "should have recorded rule_triggered telemetry");
  is(events[0].extra.url, "", "url should be empty when UrlLogging is none");
  await SpecialPowers.popPrefEnv();
});

add_task(async function testUrlLoggingPolicyDomain() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.contentanalysis.enterprise.telemetry.urlLogging", "domain"],
    ],
  });
  const events = await pasteAndGetTelemetryEvents({
    allow: false,
    useDataUrl: false,
  });
  ok(events, "should have recorded rule_triggered telemetry");
  is(
    events[0].extra.url,
    "example.com",
    "url should be reduced to the hostname when UrlLogging is domain"
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function testUrlLoggingPolicyFullUrl() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.contentanalysis.enterprise.telemetry.urlLogging", "full"]],
  });
  const events = await pasteAndGetTelemetryEvents({
    allow: false,
    useDataUrl: false,
  });
  ok(events, "should have recorded rule_triggered telemetry");
  is(events[0].extra.url, TEST_PAGE_URL);
  await SpecialPowers.popPrefEnv();
});

async function pasteAndGetWarnResolutionEvents({ allowAfterWarn }) {
  mockCA.setupForTest("warn", /* waitForEvent */ false, /* showDialogs */ true);
  Services.fog.testResetFOG();

  let tab = BrowserTestUtils.addTab(gBrowser);
  let browser = gBrowser.getBrowserForTab(tab);
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.loadURIString({
    browser: tab.linkedBrowser,
    uriString: "data:text/html," + escape(testPage),
  });
  await SimpleTest.promiseFocus(browser);

  setClipboardData(CLIPBOARD_TEXT_STRING);

  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("input").value = "";
    content.document.getElementById("input").focus();
  });

  let warnDialogPromise = BrowserTestUtils.promiseAlertDialogOpen();
  // Deliberately not awaited here: a warn verdict doesn't resolve the paste
  // until respondToWarnDialog() is called, and synthesizeKey() doesn't
  // resolve until the paste it triggered has been handled. Awaiting it
  // before answering the dialog deadlocks the test.
  let keyPromise = BrowserTestUtils.synthesizeKey(
    "v",
    { accelKey: true },
    browser
  );
  let win = await warnDialogPromise;
  win.document
    .querySelector("dialog")
    .getButton(allowAfterWarn ? "accept" : "cancel")
    .click();
  await keyPromise;

  // respondToWarnDialog() resolves asynchronously (it goes through the
  // "dlp-warn-resolved" notification), so wait for the second event
  // instead of assuming it's recorded by the time the click returns.
  await TestUtils.waitForCondition(() => {
    const events =
      Glean.contentAnalysis.ruleTriggered.testGetValue("enterprise");
    return events && events.length >= 2;
  }, "waiting for warn_resolution telemetry to be recorded");

  BrowserTestUtils.removeTab(tab);

  return Glean.contentAnalysis.ruleTriggered.testGetValue("enterprise");
}

add_task(async function testWarnThenAllowRecordsResolutionTelemetry() {
  const events = await pasteAndGetWarnResolutionEvents({
    allowAfterWarn: true,
  });
  ok(events, "should have recorded rule_triggered telemetry");
  is(events.length, 2, "should record the warn trigger and its resolution");
  is(events[0].extra.action, "warn", "first event reports the warn verdict");
  is(events[0].extra.type, "verdict", "first event is the verdict");
  is(events[1].extra.action, "allow", "second event reports the user's choice");
  is(
    events[1].extra.type,
    "warn_resolution",
    "second event is the warn resolution"
  );
  is(events[1].extra.operation, "clipboard");
  is(
    events[1].extra.analysis_type,
    "BULK_DATA_ENTRY",
    "the resolution event carries the original request's analysis_type"
  );
  is(
    events[1].extra.reason,
    "CLIPBOARD_PASTE",
    "the resolution event carries the original request's reason"
  );
});

add_task(async function testWarnThenBlockRecordsResolutionTelemetry() {
  const events = await pasteAndGetWarnResolutionEvents({
    allowAfterWarn: false,
  });
  ok(events, "should have recorded rule_triggered telemetry");
  is(events.length, 2, "should record the warn trigger and its resolution");
  is(events[0].extra.action, "warn", "first event reports the warn verdict");
  is(events[1].extra.action, "block", "second event reports the user's choice");
  is(
    events[1].extra.type,
    "warn_resolution",
    "second event is the warn resolution"
  );
});

add_task(async function testTelemetryDisabledEntirely() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.contentanalysis.enterprise.telemetry.enabled", false]],
  });
  const events = await pasteAndGetTelemetryEvents({ allow: false });
  is(
    events,
    null,
    "should not record any rule_triggered telemetry when the policy disables it"
  );
  await SpecialPowers.popPrefEnv();
});
