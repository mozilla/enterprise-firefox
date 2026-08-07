/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Verifies the DataLossPrevention policy and its arbitration with the external
// ContentAnalysis policy, as implemented by reconcileContentAnalysis in
// ContentAnalysisPolicies.sys.mjs. Assertions are on the
// browser.contentanalysis.* prefs the handler sets; the built-in WASM backend
// consumes them.

const CA_PREFIX = "browser.contentanalysis.";

const INTERCEPTION_POINTS = [
  "clipboard",
  "download",
  "drag_and_drop",
  "file_upload",
  "print",
];

function getSerializedRules() {
  let json = Services.prefs.getStringPref(CA_PREFIX + "dlp_rules", "");
  return json ? JSON.parse(json).DLPRules.Rules : [];
}

function assertInterceptionPoints(expectedOn, message) {
  for (let point of INTERCEPTION_POINTS) {
    is(
      Services.prefs.getBoolPref(
        `${CA_PREFIX}interception_point.${point}.enabled`,
        false
      ),
      expectedOn.includes(point),
      `${message}: interception_point.${point}.enabled`
    );
  }
}

function dlpRule(name, actions, extra = {}) {
  return {
    Name: name,
    Enabled: true,
    Actions: actions,
    Domains: ["example.com"],
    Type: "block",
    ...extra,
  };
}

registerCleanupFunction(async function () {
  await setupPolicyEngineWithJson({ policies: {} });
});

add_task(async function test_builtin_dlp_only() {
  await setupPolicyEngineWithJson({
    policies: {
      DataLossPrevention: {
        FallbackResult: "block",
        Rules: [
          {
            Name: "warn-ai-paste",
            Enabled: true,
            Actions: ["TextPaste"],
            Domains: ["chatgpt.com"],
            Type: "warn",
          },
        ],
      },
    },
  });

  is(Services.prefs.getBoolPref(CA_PREFIX + "enabled"), true, "CA enabled");
  is(
    Services.prefs.getBoolPref(CA_PREFIX + "use_wasm_backend"),
    true,
    "built-in WASM backend selected"
  );
  is(
    Services.prefs.getStringPref(CA_PREFIX + "agent_name", ""),
    "Firefox Enterprise DLP Engine",
    "built-in agent name set"
  );
  // FallbackResult "block" maps to the numeric result 0.
  is(
    Services.prefs.getIntPref(CA_PREFIX + "default_result"),
    0,
    "default_result"
  );
  is(
    Services.prefs.getIntPref(CA_PREFIX + "timeout_result"),
    0,
    "timeout_result"
  );

  // TextPaste derives clipboard + drag_and_drop; the rest are off.
  let expectedOn = new Set(["clipboard", "drag_and_drop"]);
  for (let point of INTERCEPTION_POINTS) {
    is(
      Services.prefs.getBoolPref(
        `${CA_PREFIX}interception_point.${point}.enabled`
      ),
      expectedOn.has(point),
      `interception_point.${point}.enabled`
    );
  }

  let rules = getSerializedRules();
  is(rules.length, 1, "one rule serialized to dlp_rules");
  is(rules[0].Name, "warn-ai-paste", "correct rule serialized");
});

add_task(async function test_external_suppresses_builtin() {
  await setupPolicyEngineWithJson({
    policies: {
      ContentAnalysis: { Enabled: true },
      DataLossPrevention: {
        Rules: [
          {
            Name: "warn-ai-paste",
            Enabled: true,
            Actions: ["TextPaste"],
            Domains: ["chatgpt.com"],
            Type: "warn",
          },
        ],
      },
    },
  });

  is(Services.prefs.getBoolPref(CA_PREFIX + "enabled"), true, "CA enabled");
  is(
    Services.prefs.getBoolPref(CA_PREFIX + "use_wasm_backend"),
    false,
    "external agent backend selected when ContentAnalysis is enabled"
  );
  is(
    Services.prefs.getStringPref(CA_PREFIX + "dlp_rules", ""),
    "",
    "built-in rules not delivered while the external agent is authoritative"
  );
});

add_task(async function test_builtin_active_when_external_disabled() {
  await setupPolicyEngineWithJson({
    policies: {
      ContentAnalysis: { Enabled: false },
      DataLossPrevention: {
        Rules: [
          {
            Name: "block-upload",
            Enabled: true,
            Actions: ["FileUpload"],
            Domains: ["dropbox.com"],
            Type: "block",
          },
        ],
      },
    },
  });

  is(
    Services.prefs.getBoolPref(CA_PREFIX + "use_wasm_backend"),
    true,
    "built-in backend runs when ContentAnalysis is present but disabled"
  );
  let rules = getSerializedRules();
  is(rules.length, 1, "built-in rule delivered");
  is(rules[0].Name, "block-upload", "correct rule");
});

add_task(async function test_invalid_regex_rule_excluded() {
  await setupPolicyEngineWithJson({
    policies: {
      DataLossPrevention: {
        Rules: [
          {
            Name: "bad-pattern",
            Enabled: true,
            Actions: ["FileUpload"],
            Domains: ["*"],
            ContentPatterns: ["("],
            Type: "block",
          },
          {
            Name: "good-pattern",
            Enabled: true,
            Actions: ["FileUpload"],
            Domains: ["*"],
            ContentPatterns: ["secret"],
            Type: "block",
          },
        ],
      },
    },
  });

  let rules = getSerializedRules();
  is(rules.length, 1, "rule with an invalid ContentPatterns regex is excluded");
  is(rules[0].Name, "good-pattern", "the valid rule survives");
});

// The remaining Actions map to the download and print interception points;
// TextPaste and FileUpload are covered above.
add_task(async function test_interception_points_from_download_and_print() {
  await setupPolicyEngineWithJson({
    policies: {
      DataLossPrevention: {
        Rules: [
          dlpRule("block-download", ["FileDownload"]),
          dlpRule("block-print", ["Print"]),
        ],
      },
    },
  });

  assertInterceptionPoints(
    ["download", "print"],
    "FileDownload and Print derive only their own interception points"
  );
});

// A rule that is present but disabled must still be delivered (the engine skips
// disabled rules itself) while contributing nothing to the interception points,
// so turning a rule off cannot leave its hooks running.
add_task(async function test_disabled_rule_does_not_enable_interception() {
  await setupPolicyEngineWithJson({
    policies: {
      DataLossPrevention: {
        Rules: [
          dlpRule("enabled-paste", ["TextPaste"]),
          dlpRule("disabled-print", ["Print"], { Enabled: false }),
        ],
      },
    },
  });

  assertInterceptionPoints(
    ["clipboard", "drag_and_drop"],
    "a disabled rule's Actions do not enable interception points"
  );
  is(
    getSerializedRules().length,
    2,
    "both rules are delivered; the engine applies the Enabled flag"
  );
});

// FallbackResult maps to both default_result and timeout_result. "block" (0) is
// covered above; check the other two and the default when it is omitted.
add_task(async function test_fallback_result_mapping() {
  for (let [fallback, expected] of [
    ["allow", 2],
    ["warn", 1],
  ]) {
    await setupPolicyEngineWithJson({
      policies: {
        DataLossPrevention: {
          FallbackResult: fallback,
          Rules: [dlpRule("a-rule", ["TextPaste"])],
        },
      },
    });

    is(
      Services.prefs.getIntPref(CA_PREFIX + "default_result"),
      expected,
      `FallbackResult "${fallback}" maps to default_result ${expected}`
    );
    is(
      Services.prefs.getIntPref(CA_PREFIX + "timeout_result"),
      expected,
      `FallbackResult "${fallback}" maps to timeout_result ${expected}`
    );
  }

  await setupPolicyEngineWithJson({
    policies: {
      DataLossPrevention: { Rules: [dlpRule("a-rule", ["TextPaste"])] },
    },
  });
  is(
    Services.prefs.getIntPref(CA_PREFIX + "default_result"),
    0,
    "an omitted FallbackResult blocks by default"
  );
});

add_task(async function test_allow_url_regex_list() {
  const allowList = "https://ok\\.example\\.com/.*";
  await setupPolicyEngineWithJson({
    policies: {
      DataLossPrevention: {
        AllowUrlRegexList: allowList,
        Rules: [dlpRule("a-rule", ["TextPaste"])],
      },
    },
  });

  checkLockedPref(CA_PREFIX + "allow_url_regex_list", allowList);
});

// The built-in provider pins every shared pref to a fixed value rather than
// inheriting whatever was there, and locks them so the user cannot edit them.
add_task(async function test_builtin_fixed_prefs_are_set_and_locked() {
  await setupPolicyEngineWithJson({
    policies: {
      DataLossPrevention: { Rules: [dlpRule("a-rule", ["TextPaste"])] },
    },
  });

  checkLockedPref(CA_PREFIX + "enabled", true);
  checkLockedPref(CA_PREFIX + "use_wasm_backend", true);
  checkLockedPref(CA_PREFIX + "deny_url_regex_list", "");
  checkLockedPref(CA_PREFIX + "agent_timeout", 300);
  checkLockedPref(CA_PREFIX + "show_blocked_result", true);
  checkLockedPref(CA_PREFIX + "bypass_for_same_tab_operations", false);
  checkLockedPref(CA_PREFIX + "agent_name", "Firefox Enterprise DLP Engine");

  for (let point of ["clipboard", "drag_and_drop"]) {
    checkLockedPref(
      `${CA_PREFIX}interception_point.${point}.plain_text_only`,
      true
    );
  }
});

// External-agent-only prefs must be released when the built-in engine wins, so
// its connection settings cannot linger in a profile the agent no longer serves.
add_task(async function test_external_only_prefs_released_for_builtin() {
  await setupPolicyEngineWithJson({
    policies: {
      ContentAnalysis: {
        Enabled: false,
        PipePathName: "a_pipe_name",
        ClientSignature: "a_signature",
        MaxConnectionsCount: 5,
        IsPerUser: true,
      },
      DataLossPrevention: { Rules: [dlpRule("a-rule", ["TextPaste"])] },
    },
  });

  is(
    Services.prefs.getBoolPref(CA_PREFIX + "use_wasm_backend"),
    true,
    "the built-in engine wins over a disabled ContentAnalysis policy"
  );
  for (let pref of [
    "pipe_path_name",
    "client_signature",
    "max_connections",
    "is_per_user",
  ]) {
    ok(
      !Services.prefs.prefIsLocked(CA_PREFIX + pref),
      `${pref} is released rather than locked at the external agent's value`
    );
  }
  isnot(
    Services.prefs.getStringPref(CA_PREFIX + "pipe_path_name", ""),
    "a_pipe_name",
    "the external agent's pipe name did not survive"
  );
  isnot(
    Services.prefs.getStringPref(CA_PREFIX + "client_signature", ""),
    "a_signature",
    "the external agent's client signature did not survive"
  );
});
