/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Integration test for the C++ WasmModuleBackend, the ContentAnalysis backend
// selected by browser.contentanalysis.use_wasm_backend. It serializes a request
// to the content_analysis SDK protobuf, resolves the request's content,
// and hands both to the in-process wasm DLP module via nsIContentAnalysisWasmRunner.
//
// The wasm module is fetched from the enterprise console (ConsoleClient) and
// read through the real production path, with ConsoleClient's fetch methods
// stubbed to serve the module bundled as a test support-file (see
// stubDlpWasmModule in head.js).
//
// That module is the test double built from tests/wasm/, not the real policy
// engine: it does no matching, and instead reads a "ruleName=action;..." spec
// out of the content under analysis and reports exactly those rules as
// triggered. So a request's verdict is chosen by the content each test submits
// (see the SPEC_* constants), and the domains and patterns on the rules below
// are never consulted. Matching itself is covered by the real module's own
// tests.
//
// The rules are still delivered the way the DataLossPrevention policy delivers
// them in production, through the browser.contentanalysis.dlp_rules pref that
// WasmModuleBackend reads, because the backend recovers a triggered rule's
// admin-authored Message by looking its name up in that set.

const WARN_RULE = "warn-ai-paste";
const WARN_RULE_MESSAGE =
  "Pasting work data into AI services may violate company policy.";
const BLOCK_RULE = "block-confidential-content";
const BLOCK_RULE_MESSAGE =
  "Content marked CONFIDENTIAL may not leave the organization.";
const BLOCK_RULE_NO_MESSAGE = "block-cloud-uploads";

// Content that makes the test module report a given verdict.
const SPEC_WARN = `${WARN_RULE}=warn`;
const SPEC_BLOCK = `${BLOCK_RULE}=block`;
const SPEC_BLOCK_NO_MESSAGE = `${BLOCK_RULE_NO_MESSAGE}=block`;
// Content that triggers no rules at all, which Firefox reads as allow.
const SPEC_ALLOW = "";

const DLP_RULES = {
  DLPRules: {
    Rules: [
      {
        Name: WARN_RULE,
        Enabled: true,
        Actions: ["TextPaste", "FileUpload"],
        Domains: ["chatgpt.com", "claude.ai", "gemini.google.com"],
        Type: "warn",
        Message: WARN_RULE_MESSAGE,
      },
      {
        Name: BLOCK_RULE_NO_MESSAGE,
        Enabled: true,
        Actions: ["FileUpload"],
        Domains: ["drive.google.com", "dropbox.com", "wetransfer.com"],
        Type: "block",
      },
      {
        Name: BLOCK_RULE,
        Enabled: true,
        ContentPatterns: ["\\bCONFIDENTIAL\\b"],
        Type: "block",
        Message: BLOCK_RULE_MESSAGE,
      },
    ],
  },
};

// Prefs must be set before the ContentAnalysis service is first instantiated,
// since the backend is chosen once in its constructor.
Services.prefs.setBoolPref("browser.contentanalysis.use_wasm_backend", true);
Services.prefs.setBoolPref("browser.contentanalysis.enabled", true);
Services.prefs.setBoolPref(
  "browser.contentanalysis.interception_point.file_upload.enabled",
  true
);
Services.prefs.setBoolPref(
  "browser.contentanalysis.interception_point.clipboard.enabled",
  true
);
Services.prefs.setBoolPref(
  "browser.contentanalysis.bypass_for_same_tab_operations",
  false
);
Services.prefs.setStringPref(
  "browser.contentanalysis.allow_url_regex_list",
  ""
);
Services.prefs.setStringPref("browser.contentanalysis.deny_url_regex_list", "");
Services.prefs.setStringPref(
  "browser.contentanalysis.dlp_rules",
  JSON.stringify(DLP_RULES)
);

const contentAnalysis = Cc["@mozilla.org/contentanalysis;1"].getService(
  Ci.nsIContentAnalysis
);

// Build a plain-object nsIContentAnalysisRequest. ContentAnalysis fills in the
// request token, user action ID, and request count itself, so we leave those
// empty.
function makeRequest({
  analysisType,
  reason,
  operationTypeForDisplay,
  urlSpec,
  filePath = "",
  textContent = "",
  fileNameForDisplay = "",
  printData = [],
  printerName = "",
}) {
  return {
    analysisType,
    reason,
    operationTypeForDisplay,
    fileNameForDisplay,
    url: Services.io.newURI(urlSpec),
    filePath,
    textContent,
    resources: [],
    email: "",
    sha256Digest: "",
    requestToken: "",
    userActionId: "",
    userActionRequestsCount: 0,
    timeoutMultiplier: 0,
    getPrintData: () => printData,
    printerName,
    dataTransfer: null,
    transferable: null,
    windowGlobalParent: null,
    sourceWindowGlobal: null,
    testOnlyIgnoreCanceledAndAlwaysSubmitToAgent: false,
  };
}

const DLP_RULES_PREF = "browser.contentanalysis.dlp_rules";

function setDlpRules(rules) {
  Services.prefs.setStringPref(
    DLP_RULES_PREF,
    JSON.stringify({ DLPRules: { Rules: rules } })
  );
}

function restoreDefaultDlpRules() {
  Services.prefs.setStringPref(DLP_RULES_PREF, JSON.stringify(DLP_RULES));
}

// Write a temp file with the given contents and return its absolute path,
// registering cleanup.
async function makeTempFile(name, contents) {
  const file = do_get_tempdir();
  file.append(name);
  await IOUtils.writeUTF8(file.path, contents);
  registerCleanupFunction(async () => {
    await IOUtils.remove(file.path, { ignoreAbsent: true });
  });
  return file.path;
}

add_setup(async function () {
  contentAnalysis.testOnlySetCACmdLineArg(true);
  Assert.ok(
    contentAnalysis.isActive,
    "content analysis is active with the wasm backend"
  );
  registerCleanupFunction(() => {
    contentAnalysis.testOnlySetCACmdLineArg(false);
  });
});

// A file's contents are read off the main thread and passed to the module as
// content bytes. Putting a blocking spec in the file proves those bytes
// actually arrive: nothing else in the request could produce this verdict.
add_task(async function test_file_upload_content_reaches_module() {
  await stubDlpWasmModule();
  const filePath = await makeTempFile("dlp_blocked_upload.txt", SPEC_BLOCK);

  const result = await contentAnalysis.analyzeContentRequests(
    [
      makeRequest({
        analysisType: Ci.nsIContentAnalysisRequest.eFileAttached,
        reason: Ci.nsIContentAnalysisRequest.eFilePickerDialog,
        operationTypeForDisplay: Ci.nsIContentAnalysisRequest.eUpload,
        fileNameForDisplay: "dlp_blocked_upload.txt",
        urlSpec: "https://example.com/upload",
        filePath,
      }),
    ],
    true
  );

  Assert.ok(
    !result.shouldAllowContent,
    "a file whose contents trigger a block rule is blocked"
  );
});

// The same path with content that triggers nothing must come back allowed.
add_task(async function test_file_upload_is_allowed_when_nothing_triggers() {
  await stubDlpWasmModule();
  const filePath = await makeTempFile("dlp_allowed_upload.txt", SPEC_ALLOW);

  const result = await contentAnalysis.analyzeContentRequests(
    [
      makeRequest({
        analysisType: Ci.nsIContentAnalysisRequest.eFileAttached,
        reason: Ci.nsIContentAnalysisRequest.eFilePickerDialog,
        operationTypeForDisplay: Ci.nsIContentAnalysisRequest.eUpload,
        fileNameForDisplay: "dlp_allowed_upload.txt",
        urlSpec: "https://example.com/upload",
        filePath,
      }),
    ],
    true
  );

  Assert.ok(
    result.shouldAllowContent,
    "a file upload triggering no rules is allowed"
  );
});

// Text (bulk data entry) requests take the synchronous, no-file path in the
// backend; verify it still works alongside the file path.
add_task(async function test_text_paste_is_allowed_when_nothing_triggers() {
  await stubDlpWasmModule();

  const result = await contentAnalysis.analyzeContentRequests(
    [
      makeRequest({
        analysisType: Ci.nsIContentAnalysisRequest.eBulkDataEntry,
        reason: Ci.nsIContentAnalysisRequest.eClipboardPaste,
        operationTypeForDisplay: Ci.nsIContentAnalysisRequest.ePasteClipboard,
        urlSpec: "https://example.com/",
        textContent: SPEC_ALLOW,
      }),
    ],
    true
  );

  Assert.ok(
    result.shouldAllowContent,
    "a text paste triggering no rules is allowed"
  );
});

// Unlike files and print data, pasted text travels inline in the request proto
// as text_content rather than as content bytes (WasmModuleBackend::Analyze
// passes none for eBulkDataEntry). Putting the spec in the pasted text proves
// that inline field reaches the module.
add_task(async function test_text_paste_content_reaches_module() {
  await stubDlpWasmModule();

  const result = await contentAnalysis.analyzeContentRequests(
    [
      makeRequest({
        analysisType: Ci.nsIContentAnalysisRequest.eBulkDataEntry,
        reason: Ci.nsIContentAnalysisRequest.eClipboardPaste,
        operationTypeForDisplay: Ci.nsIContentAnalysisRequest.ePasteClipboard,
        urlSpec: "https://example.com/",
        textContent: SPEC_BLOCK,
      }),
    ],
    true
  );

  Assert.ok(
    !result.shouldAllowContent,
    "pasted text triggering a block rule is blocked"
  );
});

// Start an analysis and return the nsIContentAnalysisResponse it produces.
//
// The rule name and message live on the response, which is only published
// through the "dlp-response" notification -- the same one ContentAnalysis.sys.mjs
// listens on to decide which dialog to show. Awaiting analyzeContentRequests()
// instead would not do: it resolves with an nsIContentAnalysisResult, which
// carries neither, and on a warn verdict it stays pending until
// respondToWarnDialog() is called, which no dialog is here to do.
//
// So the response is delivered out of band, and this waits for it: subscribe
// first (a notification that fires before we are listening is lost), then let
// aMakeRequest start the analysis. The observer unsubscribes itself before
// resolving, so it can't go on to resolve a later caller's promise.
//
// @param {Function} aMakeRequest Starts one analysis. Must not await it, for
//   the warn reason above.
function observeResponse(aMakeRequest) {
  return new Promise(resolve => {
    const observer = subject => {
      Services.obs.removeObserver(observer, "dlp-response");
      resolve(subject.QueryInterface(Ci.nsIContentAnalysisResponse));
    };
    Services.obs.addObserver(observer, "dlp-response");
    aMakeRequest();
  });
}

function pasteAndGetResponse(textContent, urlSpec = "https://example.com/") {
  return observeResponse(() => {
    contentAnalysis.analyzeContentRequests(
      [
        makeRequest({
          analysisType: Ci.nsIContentAnalysisRequest.eBulkDataEntry,
          reason: Ci.nsIContentAnalysisRequest.eClipboardPaste,
          operationTypeForDisplay: Ci.nsIContentAnalysisRequest.ePasteClipboard,
          urlSpec,
          textContent,
        }),
      ],
      true
    );
  });
}

add_task(async function test_block_verdict_reports_rule_message() {
  await stubDlpWasmModule();

  const response = await pasteAndGetResponse(SPEC_BLOCK);

  Assert.equal(response.ruleName, BLOCK_RULE, "the block rule is reported");
  Assert.equal(
    response.ruleMessage,
    BLOCK_RULE_MESSAGE,
    "the triggered rule's admin message is reported on the response"
  );
});

add_task(async function test_warn_verdict_reports_rule_message() {
  await stubDlpWasmModule();

  const response = await pasteAndGetResponse(SPEC_WARN);

  Assert.equal(
    response.action,
    Ci.nsIContentAnalysisResponse.eWarn,
    "a warn rule produces a warn verdict"
  );
  Assert.equal(
    response.ruleMessage,
    WARN_RULE_MESSAGE,
    "the warn rule's admin message is reported too"
  );

  // Clean up the pending warn dialog.
  contentAnalysis.respondToWarnDialog(response.requestToken, false);
});

add_task(async function test_verdict_from_rule_without_message() {
  await stubDlpWasmModule();

  const response = await pasteAndGetResponse(SPEC_BLOCK_NO_MESSAGE);

  Assert.equal(
    response.ruleName,
    BLOCK_RULE_NO_MESSAGE,
    "the message-less rule produced the verdict"
  );
  Assert.equal(
    response.ruleMessage,
    "",
    "ruleMessage is empty when the triggered rule configures no Message"
  );
});

// A rule name the policy doesn't define must not be mistaken for a match, or a
// stale rule set could attach the wrong administrator's message to a verdict.
add_task(async function test_unknown_rule_name_reports_no_message() {
  await stubDlpWasmModule();

  const response = await pasteAndGetResponse("not-in-the-policy=block");

  Assert.equal(
    response.ruleName,
    "not-in-the-policy",
    "the reported rule name is whatever the module sent"
  );
  Assert.equal(
    response.ruleMessage,
    "",
    "no message is attached when the name matches no configured rule"
  );
});

// When several rules trigger, ConvertResponseFromProtobuf keeps the most severe
// action, and the message must come from that same rule rather than whichever
// one happened to be listed first.
add_task(async function test_most_severe_rule_supplies_the_message() {
  await stubDlpWasmModule();

  const response = await pasteAndGetResponse(`${SPEC_WARN};${SPEC_BLOCK}`);

  Assert.equal(
    response.action,
    Ci.nsIContentAnalysisResponse.eBlock,
    "block outranks warn"
  );
  Assert.equal(response.ruleName, BLOCK_RULE, "the block rule is the winner");
  Assert.equal(
    response.ruleMessage,
    BLOCK_RULE_MESSAGE,
    "the message comes from the winning rule, not the first one listed"
  );
});

// Print requests fetch their content via the cross-platform GetPrintData,
// unlike ExternalAgentBackend which (on the request-conversion path shared
// with the WASM backend) only knows how to ship print data via a Windows
// shared-memory handle. Verify the WASM backend correctly hands print data to
// the module on every platform.
add_task(async function test_print_data_reaches_module() {
  await stubDlpWasmModule();

  const before = await contentAnalysis.getDiagnosticInfo();

  const printData = Array.from(new TextEncoder().encode(SPEC_BLOCK));
  const result = await contentAnalysis.analyzeContentRequests(
    [
      makeRequest({
        analysisType: Ci.nsIContentAnalysisRequest.ePrint,
        reason: Ci.nsIContentAnalysisRequest.eSystemDialogPrint,
        operationTypeForDisplay: Ci.nsIContentAnalysisRequest.eOperationPrint,
        urlSpec: "https://example.com/",
        printData,
        printerName: "Test Printer",
      }),
    ],
    true
  );

  Assert.ok(
    !result.shouldAllowContent,
    "print data triggering a block rule is blocked, so the data arrived"
  );

  const after = await contentAnalysis.getDiagnosticInfo();
  Assert.equal(
    after.requestCount,
    before.requestCount + 1,
    "the print request reached the module instead of failing before " +
      "it got there"
  );
  Assert.ok(
    after.connectedToAgent,
    "connected after analyzing a print request"
  );
});

// GetDiagnosticInfo should track the number of analyze() calls and report
// that the module is connected after it runs successfully.
add_task(async function test_diagnostic_info_tracks_successful_analysis() {
  await stubDlpWasmModule();

  const before = await contentAnalysis.getDiagnosticInfo();

  await contentAnalysis.analyzeContentRequests(
    [
      makeRequest({
        analysisType: Ci.nsIContentAnalysisRequest.eBulkDataEntry,
        reason: Ci.nsIContentAnalysisRequest.eClipboardPaste,
        operationTypeForDisplay: Ci.nsIContentAnalysisRequest.ePasteClipboard,
        urlSpec: "https://example.com/",
        textContent: SPEC_ALLOW,
      }),
    ],
    true
  );

  const after = await contentAnalysis.getDiagnosticInfo();
  Assert.equal(
    after.requestCount,
    before.requestCount + 1,
    "requestCount increases by one per analyze() call"
  );
  Assert.ok(after.connectedToAgent, "connected after a successful analysis");
  Assert.ok(
    !after.failedSignatureVerification,
    "no signature failure after a successful analysis"
  );
});

async function uploadToExample(contents = SPEC_ALLOW) {
  const filePath = await makeTempFile("dlp_rule_cache.txt", contents);
  return contentAnalysis.analyzeContentRequests(
    [
      makeRequest({
        analysisType: Ci.nsIContentAnalysisRequest.eFileAttached,
        reason: Ci.nsIContentAnalysisRequest.eFilePickerDialog,
        operationTypeForDisplay: Ci.nsIContentAnalysisRequest.eUpload,
        fileNameForDisplay: "dlp_rule_cache.txt",
        urlSpec: "https://example.com/upload",
        filePath,
      }),
    ],
    true
  );
}

// Whether a request was allowed, treating a failure to analyze as "not allowed"
// so a fail-closed error and an explicit block are both reported as blocked.
async function uploadWasAllowed() {
  try {
    return (await uploadToExample()).shouldAllowContent;
  } catch (e) {
    return false;
  }
}

// WasmModuleBackend caches the parsed rules keyed on the dlp_rules pref string.
// A policy-locked pref does not reliably notify observers, so that string
// comparison is the only thing keeping the rules current after a live policy
// update -- if it regressed, the first rule set would be used forever.
//
// The test module ignores the rules, so what makes the cached set observable
// here is the Message the backend recovers from it for the triggered rule.
add_task(async function test_changed_rules_take_effect_without_invalidation() {
  await stubDlpWasmModule();

  const ruleWithMessage = message => [
    {
      Name: "cached-rule",
      Enabled: true,
      Actions: ["FileUpload"],
      Domains: ["example.com"],
      Type: "block",
      Message: message,
    },
  ];
  const uploadAndGetResponse = async () => {
    const filePath = await makeTempFile(
      "dlp_rule_cache.txt",
      "cached-rule=block"
    );
    return observeResponse(() => {
      contentAnalysis.analyzeContentRequests(
        [
          makeRequest({
            analysisType: Ci.nsIContentAnalysisRequest.eFileAttached,
            reason: Ci.nsIContentAnalysisRequest.eFilePickerDialog,
            operationTypeForDisplay: Ci.nsIContentAnalysisRequest.eUpload,
            fileNameForDisplay: "dlp_rule_cache.txt",
            urlSpec: "https://example.com/upload",
            filePath,
          }),
        ],
        true
      );
    });
  };

  setDlpRules(ruleWithMessage("first message"));
  let response = await uploadAndGetResponse();
  Assert.equal(response.ruleMessage, "first message", "the rule set is used");

  // Reuse the cached rules for an identical second request.
  response = await uploadAndGetResponse();
  Assert.equal(
    response.ruleMessage,
    "first message",
    "the cached rule set is still used on a repeat request"
  );

  setDlpRules(ruleWithMessage("second message"));
  response = await uploadAndGetResponse();
  Assert.equal(
    response.ruleMessage,
    "second message",
    "a replaced rule set is picked up instead of the cached one"
  );

  restoreDefaultDlpRules();
});

// A rule set that fails to parse must not be cached as "no rules", which would
// turn a single bad policy into a silent allow-everything from the second
// request onward. Both requests below must fail closed.
add_task(async function test_unparsable_rules_are_not_cached_as_no_rules() {
  await stubDlpWasmModule();

  Services.prefs.setStringPref(DLP_RULES_PREF, "{ this is not valid JSON");

  Assert.ok(!(await uploadWasAllowed()), "an unparsable rule set fails closed");
  Assert.ok(
    !(await uploadWasAllowed()),
    "it still fails closed on the next request rather than caching as no rules"
  );

  // A valid rule set must still be adopted after the failures. The upload is
  // allowed now not because of the rule, but because parsing succeeded and the
  // request reached the module at all, whose content triggers nothing.
  setDlpRules([
    {
      Name: "block-example-uploads",
      Enabled: true,
      Actions: ["FileUpload"],
      Domains: ["example.com"],
      Type: "block",
    },
  ]);
  Assert.ok(
    await uploadWasAllowed(),
    "a valid rule set is parsed again after a failed parse"
  );

  restoreDefaultDlpRules();
});
