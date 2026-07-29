/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests for Enterprise Content Analysis (DLP) Telemetry functionality.
 * These tests only run in MOZ_ENTERPRISE builds.
 */

const { ContentAnalysisTelemetryEnterprise } = ChromeUtils.importESModule(
  "moz-src:///browser/components/contentanalysis/content/ContentAnalysisTelemetry.enterprise.sys.mjs"
);

const ENABLED_PREF = "browser.contentanalysis.enterprise.telemetry.enabled";
const URL_LOGGING_PREF =
  "browser.contentanalysis.enterprise.telemetry.urlLogging";
const DISABLE_SUBMIT_PREF =
  "browser.contentanalysis.enterprise.telemetry.testing.disableSubmit";

add_setup(function () {
  // Every task below wants submission disabled so it can inspect recorded
  // telemetry without it being cleared by GleanPings.enterprise.submit().
  Services.prefs.setBoolPref(DISABLE_SUBMIT_PREF, true);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(DISABLE_SUBMIT_PREF);
    Services.prefs.clearUserPref(ENABLED_PREF);
    Services.prefs.clearUserPref(URL_LOGGING_PREF);
  });
});

const BASE_DETAILS = {
  operation: "upload",
  url: "https://example.com/secret.docx",
  action: "block",
  type: "verdict",
  analysisType: "FILE_ATTACHED",
  reason: "FILE_PICKER_DIALOG",
};

/**
 * Records one event and returns the extras of everything recorded, or null if
 * nothing was recorded.
 *
 * @param {object} details Passed through to _record().
 * @returns {object[]|null}
 */
function recordAndGetExtras(details) {
  Services.fog.testResetFOG();
  ContentAnalysisTelemetryEnterprise._record(details);
  const events = Glean.contentAnalysis.ruleTriggered.testGetValue("enterprise");
  return events ? events.map(event => event.extra) : null;
}

add_task(async function test_url_processing_policies() {
  const testCases = [
    {
      input: "https://example.com/path/to/file.pdf?param=value#fragment",
      policy: "full",
      expected: "https://example.com/path/to/file.pdf?param=value#fragment",
    },
    {
      input: "https://example.com/path/to/file.pdf?param=value#fragment",
      policy: "domain",
      expected: "example.com",
    },
    {
      input: "https://example.com/path/to/file.pdf?param=value#fragment",
      policy: "none",
      expected: "",
    },
    {
      // An unrecognized policy value falls back to "full".
      input: "https://example.com/path/to/file.pdf?param=value#fragment",
      policy: "bogus",
      expected: "https://example.com/path/to/file.pdf?param=value#fragment",
    },
    {
      input: "invalid-url",
      policy: "full",
      expected: "invalid-url",
    },
    {
      input: "invalid-url",
      policy: "domain",
      expected: "",
    },
    {
      input: null,
      policy: "full",
      expected: "",
    },
    {
      input: "",
      policy: "domain",
      expected: "",
    },
  ];

  for (const testCase of testCases) {
    Services.prefs.setCharPref(URL_LOGGING_PREF, testCase.policy);

    Assert.strictEqual(
      ContentAnalysisTelemetryEnterprise._processUrl(testCase.input),
      testCase.expected,
      `URL processing failed for input: ${testCase.input}, policy: ${testCase.policy}`
    );

    // The same policy should apply to what actually gets recorded.
    const extras = recordAndGetExtras({ ...BASE_DETAILS, url: testCase.input });
    Assert.equal(
      extras[0].url,
      testCase.expected,
      `recorded url should honor the ${testCase.policy} policy`
    );
  }

  Services.prefs.clearUserPref(URL_LOGGING_PREF);
});

add_task(async function test_should_record_action() {
  const testCases = [
    { action: "block", expected: true },
    { action: "warn", expected: true },
    { action: "canceled", expected: true },
    // Recording is the whole point of a report-only verdict.
    { action: "report_only", expected: true },
    // Unrecognized actions are recorded rather than silently dropped.
    { action: "unknown:1234", expected: true },
    { action: "allow", expected: false },
  ];

  for (const testCase of testCases) {
    Assert.strictEqual(
      ContentAnalysisTelemetryEnterprise._shouldRecordAction(testCase.action),
      testCase.expected,
      `_shouldRecordAction failed for action: ${testCase.action}`
    );

    const extras = recordAndGetExtras({
      ...BASE_DETAILS,
      action: testCase.action,
    });
    Assert.equal(
      extras !== null,
      testCase.expected,
      `recording a ${testCase.action} verdict`
    );
  }
});

add_task(async function test_record_rule_triggered() {
  const extras = recordAndGetExtras(BASE_DETAILS);
  Assert.ok(extras, "Should have recorded events");
  Assert.equal(extras.length, 1, "Should record exactly one event");

  Assert.equal(extras[0].operation, "upload");
  Assert.equal(extras[0].url, "https://example.com/secret.docx");
  Assert.equal(extras[0].action, "block");
  Assert.equal(extras[0].type, "verdict");
  Assert.ok(
    extras[0].is_builtin === "true" || extras[0].is_builtin === "false",
    "is_builtin should be a boolean"
  );
  Assert.equal(extras[0].analysis_type, "FILE_ATTACHED");
  Assert.equal(extras[0].reason, "FILE_PICKER_DIALOG");
  Assert.equal(
    extras[0].cancel_error,
    "",
    "cancel_error should be empty when not passed"
  );
  Assert.equal(
    extras[0].is_cached,
    "false",
    "is_cached should be false when not passed"
  );
  Assert.equal(
    extras[0].rule_name,
    "",
    "rule_name should be empty when not passed"
  );
});

add_task(async function test_rule_name_is_reported_for_either_engine() {
  const details = { ...BASE_DETAILS, ruleName: "block-confidential-content" };

  // External agent (the default; browser.contentanalysis.use_wasm_backend
  // defaults to false).
  let extras = recordAndGetExtras(details);
  Assert.equal(extras[0].is_builtin, "false");
  Assert.equal(extras[0].rule_name, "block-confidential-content");

  Services.prefs.setBoolPref("browser.contentanalysis.use_wasm_backend", true);
  try {
    extras = recordAndGetExtras(details);
    Assert.equal(extras[0].is_builtin, "true");
    Assert.equal(
      extras[0].rule_name,
      "block-confidential-content",
      "rule_name should be reported for the built-in engine too"
    );
  } finally {
    Services.prefs.clearUserPref("browser.contentanalysis.use_wasm_backend");
  }
});

add_task(async function test_optional_keys_are_recorded() {
  const extras = recordAndGetExtras({
    ...BASE_DETAILS,
    action: "canceled",
    cancelError: "timeout",
    isCached: true,
  });
  Assert.ok(extras, "Should have recorded events");
  Assert.equal(extras[0].action, "canceled");
  Assert.equal(extras[0].cancel_error, "timeout");
  Assert.equal(extras[0].is_cached, "true");
});

add_task(async function test_disabled_does_not_record() {
  Services.prefs.setBoolPref(ENABLED_PREF, false);
  try {
    Assert.equal(
      recordAndGetExtras(BASE_DETAILS),
      null,
      "Should not record when disabled"
    );
    // Not even the types that bypass the "allow" outcome filter.
    Assert.equal(
      recordAndGetExtras({
        ...BASE_DETAILS,
        action: "canceled",
        type: "error_fallback",
        cancelError: "no_agent",
      }),
      null,
      "Should not record error fallbacks when disabled"
    );
  } finally {
    Services.prefs.clearUserPref(ENABLED_PREF);
  }
});

add_task(async function test_always_recorded_types_bypass_outcome_filter() {
  // Each of these has an action ("allow") that would otherwise be filtered
  // out.
  const testCases = [
    {
      what: "an error fallback that allowed the operation",
      details: { action: "allow", type: "error_fallback" },
    },
    {
      what: "a warn the user resolved by allowing",
      details: { action: "allow", type: "warn_resolution" },
    },
    {
      what: "a warn resolved by the request being canceled",
      details: { action: "allow", type: "warn_cancel" },
    },
  ];

  for (const testCase of testCases) {
    const extras = recordAndGetExtras({
      ...BASE_DETAILS,
      ...testCase.details,
    });
    Assert.ok(extras, `should record ${testCase.what}`);
    Assert.equal(extras[0].action, testCase.details.action);
    Assert.equal(extras[0].type, testCase.details.type);
  }
});

add_task(async function test_error_fallback_block_is_recorded() {
  // The common agent-failure case: browser.contentanalysis.default_result is
  // "block", so content analysis reports a canceled action rather than a
  // block. This must be recorded.
  const extras = recordAndGetExtras({
    ...BASE_DETAILS,
    action: "canceled",
    type: "error_fallback",
    cancelError: "no_agent",
  });
  Assert.ok(extras, "should record a canceled error fallback");
  Assert.equal(extras[0].action, "canceled");
  Assert.equal(extras[0].type, "error_fallback");
  Assert.equal(extras[0].cancel_error, "no_agent");
});
