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
// stubDlpWasmModule in head.js). The rules below are delivered the way
// the DataLossPrevention policy delivers them in production, through the
// browser.contentanalysis.dlp_rules pref that WasmModuleBackend reads (block
// uploads to cloud-storage domains, warn on AI domains, block content marked
// CONFIDENTIAL).

const DLP_RULES = {
  DLPRules: {
    Rules: [
      {
        Name: "warn-ai-paste",
        Enabled: true,
        Actions: ["TextPaste", "FileUpload"],
        Domains: ["chatgpt.com", "claude.ai", "gemini.google.com"],
        Type: "warn",
        Message:
          "Pasting work data into AI services may violate company policy.",
      },
      {
        Name: "block-cloud-uploads",
        Enabled: true,
        Actions: ["FileUpload"],
        Domains: ["drive.google.com", "dropbox.com", "wetransfer.com"],
        Type: "block",
      },
      {
        Name: "block-confidential-content",
        Enabled: true,
        ContentPatterns: ["\\bCONFIDENTIAL\\b"],
        Type: "block",
        Message: "Content marked CONFIDENTIAL may not leave the organization.",
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

// A file uploaded to a cloud-storage domain must be blocked. This exercises
// reading the file's contents off the main thread before handing them to the
// module.
add_task(async function test_file_upload_to_blocked_domain_is_blocked() {
  await stubDlpWasmModule();
  const filePath = await makeTempFile(
    "dlp_blocked_upload.txt",
    "contents of a file being uploaded to cloud storage"
  );

  const result = await contentAnalysis.analyzeContentRequests(
    [
      makeRequest({
        analysisType: Ci.nsIContentAnalysisRequest.eFileAttached,
        reason: Ci.nsIContentAnalysisRequest.eFilePickerDialog,
        operationTypeForDisplay: Ci.nsIContentAnalysisRequest.eUpload,
        fileNameForDisplay: "dlp_blocked_upload.txt",
        urlSpec: "https://drive.google.com/upload",
        filePath,
      }),
    ],
    true
  );

  Assert.ok(
    !result.shouldAllowContent,
    "file upload to drive.google.com is blocked"
  );
});

// The same file uploaded to an unlisted domain is allowed. This still reads the
// file off the main thread and round-trips it through the module.
add_task(async function test_file_upload_to_unlisted_domain_is_allowed() {
  await stubDlpWasmModule();
  const filePath = await makeTempFile(
    "dlp_allowed_upload.txt",
    "contents of a file being uploaded to an ordinary site"
  );

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

  Assert.ok(result.shouldAllowContent, "file upload to example.com is allowed");
});

// An empty file must still round-trip cleanly (the off-main-thread read handles
// a zero-length file by passing empty content) and be allowed on an unlisted
// domain.
add_task(async function test_empty_file_upload_is_allowed() {
  await stubDlpWasmModule();
  const filePath = await makeTempFile("dlp_empty_upload.txt", "");

  const result = await contentAnalysis.analyzeContentRequests(
    [
      makeRequest({
        analysisType: Ci.nsIContentAnalysisRequest.eFileAttached,
        reason: Ci.nsIContentAnalysisRequest.eFilePickerDialog,
        operationTypeForDisplay: Ci.nsIContentAnalysisRequest.eUpload,
        fileNameForDisplay: "dlp_empty_upload.txt",
        urlSpec: "https://example.com/upload",
        filePath,
      }),
    ],
    true
  );

  Assert.ok(result.shouldAllowContent, "empty file upload is allowed");
});

// Text (bulk data entry) requests take the synchronous, no-file path in the
// backend; verify it still works alongside the file path.
add_task(async function test_text_paste_to_unlisted_domain_is_allowed() {
  await stubDlpWasmModule();

  const result = await contentAnalysis.analyzeContentRequests(
    [
      makeRequest({
        analysisType: Ci.nsIContentAnalysisRequest.eBulkDataEntry,
        reason: Ci.nsIContentAnalysisRequest.eClipboardPaste,
        operationTypeForDisplay: Ci.nsIContentAnalysisRequest.eClipboard,
        urlSpec: "https://example.com/",
        textContent: "some pasted text",
      }),
    ],
    true
  );

  Assert.ok(result.shouldAllowContent, "text paste to example.com is allowed");
});

// Pasted text is handed to the module as content bytes, separately from the
// serialized request (see WasmModuleBackend::Analyze); the module's
// block-confidential-content rule (the only example rule keyed on content
// rather than domain) only triggers if those bytes actually reach it. The
// destination domain here isn't covered by any domain-based rule, isolating
// the content path from the domain path.
add_task(async function test_text_paste_with_confidential_marker_is_blocked() {
  await stubDlpWasmModule();

  const result = await contentAnalysis.analyzeContentRequests(
    [
      makeRequest({
        analysisType: Ci.nsIContentAnalysisRequest.eBulkDataEntry,
        reason: Ci.nsIContentAnalysisRequest.eClipboardPaste,
        operationTypeForDisplay: Ci.nsIContentAnalysisRequest.eClipboard,
        urlSpec: "https://example.com/",
        textContent: "top secret plan: CONFIDENTIAL launch details",
      }),
    ],
    true
  );

  Assert.ok(
    !result.shouldAllowContent,
    "text paste containing a CONFIDENTIAL marker is blocked"
  );
});

// Same content-pattern rule, but content resolved from a file instead of
// inline text_content, to confirm the file-content path also reaches the
// module's pattern matching.
add_task(async function test_file_with_confidential_marker_is_blocked() {
  await stubDlpWasmModule();
  const filePath = await makeTempFile(
    "dlp_confidential.txt",
    "top secret plan: CONFIDENTIAL launch details"
  );

  const result = await contentAnalysis.analyzeContentRequests(
    [
      makeRequest({
        analysisType: Ci.nsIContentAnalysisRequest.eFileAttached,
        reason: Ci.nsIContentAnalysisRequest.eFilePickerDialog,
        operationTypeForDisplay: Ci.nsIContentAnalysisRequest.eUpload,
        fileNameForDisplay: "dlp_confidential.txt",
        urlSpec: "https://example.com/upload",
        filePath,
      }),
    ],
    true
  );

  Assert.ok(
    !result.shouldAllowContent,
    "file upload containing a CONFIDENTIAL marker is blocked"
  );
});

// Print requests fetch their content via the cross-platform GetPrintData,
// unlike ExternalAgentBackend which (on the request-conversion path shared
// with the WASM backend) only knows how to ship print data via a Windows
// shared-memory handle. Verify the WASM backend correctly hands print data to
// the module on every platform.
add_task(async function test_print_to_unlisted_domain_is_allowed() {
  await stubDlpWasmModule();

  const before = await contentAnalysis.getDiagnosticInfo();

  const printData = Array.from(
    new TextEncoder().encode("%PDF-1.4 fake print content for wasm test")
  );
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

  Assert.ok(result.shouldAllowContent, "print to example.com is allowed");

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
        operationTypeForDisplay: Ci.nsIContentAnalysisRequest.eClipboard,
        urlSpec: "https://example.com/",
        textContent: "some more pasted text",
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

// Upload the same file to the same domain repeatedly; only the rule set varies.
async function uploadToExample() {
  const filePath = await makeTempFile(
    "dlp_rule_cache.txt",
    "ordinary file contents"
  );
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
// update -- if it regressed, the first rule set would be enforced forever.
add_task(async function test_changed_rules_take_effect_without_invalidation() {
  await stubDlpWasmModule();

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
    !(await uploadWasAllowed()),
    "the rule blocking example.com uploads is enforced"
  );

  // Reuse the cached rules for an identical second request.
  Assert.ok(
    !(await uploadWasAllowed()),
    "the cached rule set is still enforced on a repeat request"
  );

  // Same request, but the rule set no longer covers example.com.
  setDlpRules([
    {
      Name: "block-dropbox-uploads",
      Enabled: true,
      Actions: ["FileUpload"],
      Domains: ["dropbox.com"],
      Type: "block",
    },
  ]);
  Assert.ok(
    await uploadWasAllowed(),
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

  // A valid rule set must still be adopted after the failures.
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
    !(await uploadWasAllowed()),
    "a valid rule set is parsed again after a failed parse"
  );

  restoreDefaultDlpRules();
});
