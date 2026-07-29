/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests how ContentAnalysis.sys.mjs turns nsIContentAnalysisResponses into
 * rule_triggered telemetry, in particular the cases that are hard to produce
 * from a browser test: responses Firefox synthesized because content analysis
 * itself failed, and warn verdicts resolved by the request being canceled.
 *
 * Only run in MOZ_ENTERPRISE builds.
 */

const { ContentAnalysis } = ChromeUtils.importESModule(
  "moz-src:///browser/components/contentanalysis/content/ContentAnalysis.sys.mjs"
);

const RECORD_EVENTS_PREF =
  "browser.contentanalysis.enterprise.telemetry.recordEvents";
const DISABLE_SUBMIT_PREF =
  "browser.contentanalysis.enterprise.telemetry.testing.disableSubmit";

add_setup(function () {
  Services.prefs.setBoolPref(DISABLE_SUBMIT_PREF, true);
  // Be explicit that these tests run under the default filtering policy, so
  // they show that these events survive it.
  Services.prefs.setCharPref(RECORD_EVENTS_PREF, "nonAllow");
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(DISABLE_SUBMIT_PREF);
    Services.prefs.clearUserPref(RECORD_EVENTS_PREF);
  });
});

const REQUEST_INFO = {
  resourceNameOrOperationType: {
    operationType: Ci.nsIContentAnalysisRequest.eUpload,
    name: "secret.docx",
  },
  url: "https://example.com/upload",
  analysisType: Ci.nsIContentAnalysisRequest.eFileAttached,
  reason: Ci.nsIContentAnalysisRequest.eFilePickerDialog,
};

/**
 * @param {object} properties Overrides for the response's properties.
 * @returns {object} A stand-in for an nsIContentAnalysisResponse, which is
 *   enough for the telemetry code since it only reads these properties.
 */
function makeResponse(properties) {
  return {
    requestToken: "test-token",
    action: Ci.nsIContentAnalysisResponse.eBlock,
    cancelError: Ci.nsIContentAnalysisResponse.eUserInitiated,
    isSyntheticResponse: false,
    isCachedResponse: false,
    ruleName: "",
    ...properties,
  };
}

function getRecordedExtras() {
  const events = Glean.contentAnalysis.ruleTriggered.testGetValue("enterprise");
  return events ? events.map(event => event.extra) : null;
}

function recordResponseAndGetExtras(properties) {
  Services.fog.testResetFOG();
  ContentAnalysis._maybeRecordRuleTriggeredTelemetry(
    REQUEST_INFO,
    makeResponse(properties)
  );
  return getRecordedExtras();
}

add_task(async function test_request_details_are_mapped_to_enum_names() {
  const extras = recordResponseAndGetExtras({});
  Assert.ok(extras, "should have recorded an event");
  Assert.equal(extras.length, 1, "should record exactly one event");
  Assert.equal(extras[0].operation, "upload");
  Assert.equal(extras[0].url, "https://example.com/upload");
  Assert.equal(extras[0].analysis_type, "FILE_ATTACHED");
  Assert.equal(extras[0].reason, "FILE_PICKER_DIALOG");
  Assert.equal(extras[0].action, "block");
  Assert.equal(extras[0].type, "verdict");
  Assert.equal(extras[0].cancel_error, "");
  Assert.equal(extras[0].is_cached, "false");
  Assert.equal(extras[0].rule_name, "");
});

add_task(async function test_rule_name_is_forwarded_from_response() {
  // Reported regardless of which engine produced the response (the default
  // here is an external agent; browser.contentanalysis.use_wasm_backend
  // defaults to false).
  const extras = recordResponseAndGetExtras({
    ruleName: "block-confidential-content",
  });
  Assert.equal(extras[0].rule_name, "block-confidential-content");
});

add_task(async function test_rule_name_carries_into_warn_resolution() {
  Services.fog.testResetFOG();
  ContentAnalysis._maybeRecordRuleTriggeredTelemetry(
    REQUEST_INFO,
    makeResponse({
      action: Ci.nsIContentAnalysisResponse.eWarn,
      ruleName: "warn-ai-paste",
    })
  );
  ContentAnalysis._recordWarnResolutionTelemetry(
    makeResponse({ action: Ci.nsIContentAnalysisResponse.eAllow }),
    "user"
  );
  const extras = getRecordedExtras();
  Assert.equal(extras[0].rule_name, "warn-ai-paste");
  Assert.equal(
    extras[1].rule_name,
    "warn-ai-paste",
    "the resolution should report the rule that caused the original warn"
  );
});

add_task(async function test_action_names() {
  const testCases = [
    { action: Ci.nsIContentAnalysisResponse.eBlock, expected: "block" },
    { action: Ci.nsIContentAnalysisResponse.eWarn, expected: "warn" },
    { action: Ci.nsIContentAnalysisResponse.eCanceled, expected: "canceled" },
    {
      action: Ci.nsIContentAnalysisResponse.eReportOnly,
      expected: "report_only",
    },
    {
      action: Ci.nsIContentAnalysisResponse.eUnspecified,
      expected: "unspecified",
    },
  ];
  for (const testCase of testCases) {
    // None of these is an allow, so all are recorded under the default policy.
    const extras = recordResponseAndGetExtras({ action: testCase.action });
    Assert.ok(extras, `should have recorded a ${testCase.expected} action`);
    Assert.equal(
      extras[0].action,
      testCase.expected,
      `action ${testCase.action} should be reported as ${testCase.expected}`
    );
  }
  // Clear the pending warn state the eWarn case above left behind.
  ContentAnalysis._pendingWarnTelemetryInfo.clear();
});

add_task(async function test_agent_failure_is_an_error_fallback() {
  // What content analysis reports when the agent can't be reached and
  // browser.contentanalysis.default_result is "block" (the default): a
  // synthesized cancel rather than a block.
  const extras = recordResponseAndGetExtras({
    action: Ci.nsIContentAnalysisResponse.eCanceled,
    cancelError: Ci.nsIContentAnalysisResponse.eNoAgent,
    isSyntheticResponse: true,
  });
  Assert.ok(
    extras,
    "an agent failure should be recorded under the default policy"
  );
  Assert.equal(extras[0].action, "canceled");
  Assert.equal(extras[0].type, "error_fallback");
  Assert.equal(extras[0].cancel_error, "no_agent");
});

add_task(async function test_agent_timeout_allow_fallback() {
  // The same, but with a default result of "allow": the action is an allow
  // Firefox chose rather than a verdict, so it's still an error fallback and
  // is recorded despite the default policy filtering allows out.
  const extras = recordResponseAndGetExtras({
    action: Ci.nsIContentAnalysisResponse.eAllow,
    cancelError: Ci.nsIContentAnalysisResponse.eTimeout,
    isSyntheticResponse: true,
  });
  Assert.ok(extras, "a timeout fallback should be recorded");
  Assert.equal(extras[0].action, "allow");
  Assert.equal(extras[0].type, "error_fallback");
  Assert.equal(extras[0].cancel_error, "timeout");
});

add_task(async function test_user_cancel_is_a_verdict() {
  const extras = recordResponseAndGetExtras({
    action: Ci.nsIContentAnalysisResponse.eCanceled,
    cancelError: Ci.nsIContentAnalysisResponse.eUserInitiated,
    isSyntheticResponse: true,
  });
  Assert.ok(extras, "a user cancel should be recorded");
  Assert.equal(extras[0].action, "canceled");
  Assert.equal(
    extras[0].type,
    "verdict",
    "the user canceling is not a content analysis failure"
  );
  Assert.equal(extras[0].cancel_error, "user_initiated");
});

add_task(async function test_synthetic_block_is_a_verdict() {
  // For example a URL matching browser.contentanalysis.deny_url_regex_list.
  const extras = recordResponseAndGetExtras({
    action: Ci.nsIContentAnalysisResponse.eBlock,
    isSyntheticResponse: true,
  });
  Assert.ok(extras, "a synthetic block should be recorded");
  Assert.equal(extras[0].action, "block");
  Assert.equal(extras[0].type, "verdict");
  Assert.equal(
    extras[0].cancel_error,
    "",
    "cancel_error should be unset for a response that wasn't canceled"
  );
});

add_task(async function test_cached_response_is_recorded() {
  const extras = recordResponseAndGetExtras({ isCachedResponse: true });
  Assert.ok(extras, "a cached verdict should still be recorded");
  Assert.equal(extras[0].action, "block");
  Assert.equal(extras[0].is_cached, "true");
});

/**
 * Records a warn verdict and then resolves it, returning the extras of both
 * events.
 *
 * @param {boolean} aAllowContent What the warn was resolved to.
 * @param {string} aData The "dlp-warn-resolved" notification's data.
 * @returns {object[]}
 */
function recordWarnAndResolution(aAllowContent, aData) {
  Services.fog.testResetFOG();
  ContentAnalysis._maybeRecordRuleTriggeredTelemetry(
    REQUEST_INFO,
    makeResponse({ action: Ci.nsIContentAnalysisResponse.eWarn })
  );
  ContentAnalysis._recordWarnResolutionTelemetry(
    makeResponse({
      action: aAllowContent
        ? Ci.nsIContentAnalysisResponse.eAllow
        : Ci.nsIContentAnalysisResponse.eBlock,
    }),
    aData
  );
  return getRecordedExtras();
}

add_task(async function test_warn_resolution() {
  const extras = recordWarnAndResolution(true, "user");
  Assert.equal(extras.length, 2, "should record the warn and its resolution");
  Assert.equal(extras[0].action, "warn");
  Assert.equal(extras[0].type, "verdict");
  Assert.equal(extras[1].action, "allow");
  Assert.equal(extras[1].type, "warn_resolution");
  Assert.equal(
    extras[1].reason,
    "FILE_PICKER_DIALOG",
    "the resolution should carry the original request's details"
  );
});

add_task(async function test_warn_resolved_by_cancel() {
  const extras = recordWarnAndResolution(false, "cancel");
  Assert.equal(extras.length, 2, "should record the warn and its resolution");
  Assert.equal(extras[1].action, "block");
  Assert.equal(
    extras[1].type,
    "warn_cancel",
    "a canceled warn should not look like a choice the user made"
  );
});

add_task(async function test_warn_resolved_during_quit() {
  // Quitting resolves warn dialogs from the front-end rather than from
  // cancelAllRequests(), so the notification's data says "user".
  ContentAnalysis._isRespondingToWarnDialogsForQuit = true;
  let extras;
  try {
    extras = recordWarnAndResolution(false, "user");
  } finally {
    ContentAnalysis._isRespondingToWarnDialogsForQuit = false;
  }
  Assert.equal(extras.length, 2, "should record the warn and its resolution");
  Assert.equal(extras[1].type, "warn_cancel");
});

add_task(async function test_unknown_resolution_is_ignored() {
  Services.fog.testResetFOG();
  ContentAnalysis._pendingWarnTelemetryInfo.clear();
  ContentAnalysis._recordWarnResolutionTelemetry(
    makeResponse({ action: Ci.nsIContentAnalysisResponse.eAllow }),
    "user"
  );
  Assert.equal(
    getRecordedExtras(),
    null,
    "a resolution for a warn we never recorded should be ignored"
  );
});
