/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

// ===========================================================================
// Content Analysis / built-in DLP backend arbitration
// ===========================================================================
//
// The ContentAnalysis (external agent) and DataLossPrevention (built-in WASM)
// policies drive the same single-backend Content Analysis service, so a single
// arbiter owns every pref they share. reconcileContentAnalysis runs from all
// activation/removal callbacks of both policies: reading the full active set
// of policies here yields the right result no matter which callbacks run.
// The C++ service reselects its backend on EnterprisePolicies:PolicyUpdatesApplied,
// after these prefs have settled.

const PREF_LOGLEVEL = "browser.policies.loglevel";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PoliciesUtils: "resource://gre/modules/PoliciesHelpers.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  let { ConsoleAPI } = ChromeUtils.importESModule(
    "resource://gre/modules/Console.sys.mjs"
  );
  return new ConsoleAPI({
    prefix: "ContentAnalysisPolicies",
    // tip: set maxLogLevel to "debug" and use log.debug() to create detailed
    // messages during development. See LOG_LEVELS in Console.sys.mjs for details.
    maxLogLevel: "warn",
    maxLogLevelPref: PREF_LOGLEVEL,
  });
});

// Build a browser.contentanalysis.* pref name.
function caPrefName(suffix) {
  return `browser.contentanalysis.${suffix}`;
}

// ContentAnalysis InterceptionPoints member name -> pref suffix.
const CA_INTERCEPTION_POINTS = [
  ["Clipboard", "clipboard"],
  ["Download", "download"],
  ["DragAndDrop", "drag_and_drop"],
  ["FileUpload", "file_upload"],
  ["Print", "print"],
];
const CA_PLAIN_TEXT_POINTS = [
  ["Clipboard", "clipboard"],
  ["DragAndDrop", "drag_and_drop"],
];

// Every browser.contentanalysis.* pref either provider may set, apart from the
// per-interception-point ones handled alongside these below.
const CA_SHARED_PREFS = [
  "enabled",
  "use_wasm_backend",
  "default_result",
  "timeout_result",
  "dlp_rules",
  "allow_url_regex_list",
  "deny_url_regex_list",
  "agent_timeout",
  "show_blocked_result",
  "bypass_for_same_tab_operations",
  "agent_name",
  "pipe_path_name",
  "client_signature",
  "max_connections",
  "is_per_user",
];

// Return every shared pref to its built-in default, unlocked.
function releaseContentAnalysisPrefs() {
  for (let suffix of CA_SHARED_PREFS) {
    lazy.PoliciesUtils.unsetAndUnlockPref(caPrefName(suffix));
  }
  for (let [, suffix] of CA_INTERCEPTION_POINTS) {
    lazy.PoliciesUtils.unsetAndUnlockPref(
      caPrefName(`interception_point.${suffix}.enabled`)
    );
  }
  for (let [, suffix] of CA_PLAIN_TEXT_POINTS) {
    lazy.PoliciesUtils.unsetAndUnlockPref(
      caPrefName(`interception_point.${suffix}.plain_text_only`)
    );
  }
}

export const ContentAnalysisPolicies = {
  reconcileContentAnalysis(manager) {
    let active = manager.getActivePolicies() ?? {};
    let caParam = active.ContentAnalysis;
    let dlpParam = active.DataLossPrevention;

    // Release every shared pref before applying the winner's configuration.
    // (Avoid stale prefs during a switch)
    releaseContentAnalysisPrefs();

    // The external agent is authoritative only when it is actually enabled; a
    // ContentAnalysis block that does not enable an agent doesn't suppress
    // built-in DLP.
    if (caParam?.Enabled === true) {
      applyExternalContentAnalysis(caParam);
    } else if (dlpParam) {
      applyBuiltinDlp(dlpParam);
    } else if (caParam) {
      // Match previous behavior of locking all prefs when policy present
      // and Enabled=false
      activelyDisableContentAnalysis(caParam);
    }
    // Else, neither provider is configured: the release above is the whole job.

    markContentAnalysisPolicyControlled(!!caParam || !!dlpParam);
  },

  // Validate DLP rules' ContentPatterns as regular expressions (a JS-regex
  // approximation of the module's engine), which the JSON schema cannot check.
  // Returns the rules whose patterns all compile (`valid`) and a message for
  // each rule with an invalid pattern (`errors`).
  validateDlpRules(rules) {
    let valid = [];
    let errors = [];
    for (let rule of rules) {
      let hasBadPattern = false;
      for (let pattern of rule.ContentPatterns ?? []) {
        try {
          // Compiling throws on an invalid pattern; the result is unused.
          RegExp(pattern);
        } catch (e) {
          hasBadPattern = true;
          errors.push(
            `DataLossPrevention rule "${rule.Name}": invalid ContentPatterns ` +
              `regular expression ${JSON.stringify(pattern)} (${e.message})`
          );
        }
      }
      if (!hasBadPattern) {
        valid.push(rule);
      }
    }
    return { valid, errors };
  },
};

// Apply prefs for setting up the external-agent provider.
function applyExternalContentAnalysis(caParam) {
  lazy.PoliciesUtils.setAndLockPref(caPrefName("enabled"), true);
  lazy.PoliciesUtils.setAndLockPref(caPrefName("use_wasm_backend"), false);

  applyContentAnalysisConfig(caParam);
}

// Apply prefs for setting up the built-in DLP provider.
function applyBuiltinDlp(dlpParam) {
  lazy.PoliciesUtils.setAndLockPref(caPrefName("enabled"), true);
  lazy.PoliciesUtils.setAndLockPref(caPrefName("use_wasm_backend"), true);

  // Built-in DLP policy does not have an explicit deny list, but encodes
  // domain deny behavior in the DLP rules for processing by the engine.
  lazy.PoliciesUtils.setAndLockPref(caPrefName("deny_url_regex_list"), "");
  // The request timeout stays generous (the in-process module completes quickly)
  lazy.PoliciesUtils.setAndLockPref(caPrefName("agent_timeout"), 300);
  // Built-in DLP needs to show blocked results in Firefox
  lazy.PoliciesUtils.setAndLockPref(caPrefName("show_blocked_result"), true);
  // Built-in DLP does not allow bypassing same-tab operations
  lazy.PoliciesUtils.setAndLockPref(
    caPrefName("bypass_for_same_tab_operations"),
    false
  );
  lazy.PoliciesUtils.setAndLockPref(
    caPrefName("agent_name"),
    "Firefox Enterprise DLP Engine"
  );

  // Derive interception points from the union of enabled rules' Actions, using
  // only rules whose ContentPatterns are valid regexes (the invalid ones are
  // reported to about:policies#errors and dropped here so they are neither
  // enforced nor serialized).
  let rules = ContentAnalysisPolicies.validateDlpRules(
    dlpParam.Rules ?? []
  ).valid;
  // DLP Action -> the interception-point pref suffixes it needs enabled.
  const DLP_ACTION_INTERCEPTION_POINTS = {
    TextPaste: ["clipboard", "drag_and_drop"],
    TextCopy: ["clipboard", "drag_and_drop"],
    FileUpload: ["file_upload", "drag_and_drop"],
    FileDownload: ["download"],
    Print: ["print"],
  };
  let activeInterceptionPoints = new Set();
  for (let rule of rules) {
    if (rule.Enabled !== true) {
      continue;
    }
    for (let action of rule.Actions ?? []) {
      for (let suffix of DLP_ACTION_INTERCEPTION_POINTS[action] ?? []) {
        activeInterceptionPoints.add(suffix);
      }
    }
  }
  for (let [, suffix] of CA_INTERCEPTION_POINTS) {
    lazy.PoliciesUtils.setAndLockPref(
      caPrefName(`interception_point.${suffix}.enabled`),
      activeInterceptionPoints.has(suffix)
    );
  }

  // Only look at plain-text interception points to avoid duplicate
  // block/warn dialogs for the same action.
  for (let [, suffix] of CA_PLAIN_TEXT_POINTS) {
    lazy.PoliciesUtils.setAndLockPref(
      caPrefName(`interception_point.${suffix}.plain_text_only`),
      true
    );
  }

  lazy.PoliciesUtils.setPrefIfPresentAndLock(
    dlpParam,
    "AllowUrlRegexList",
    caPrefName("allow_url_regex_list")
  );

  // Map FallbackResult to the ContentAnalysis numeric result (0 = block/deny,
  // 1 = warn, 2 = allow).
  const DLP_FALLBACK_RESULT = { block: 0, warn: 1, allow: 2 };
  let fallback = DLP_FALLBACK_RESULT[dlpParam.FallbackResult ?? "block"] ?? 0;
  lazy.PoliciesUtils.setAndLockPref(caPrefName("default_result"), fallback);
  lazy.PoliciesUtils.setAndLockPref(caPrefName("timeout_result"), fallback);

  lazy.PoliciesUtils.setAndLockPref(
    caPrefName("dlp_rules"),
    JSON.stringify({ DLPRules: { Rules: rules } })
  );
}

// A ContentAnalysis policy that is present but not enabled: keep its config
// locked with the service disabled, to match previous behavior.
function activelyDisableContentAnalysis(caParam) {
  lazy.PoliciesUtils.setAndLockPref(caPrefName("enabled"), false);
  lazy.PoliciesUtils.setAndLockPref(caPrefName("use_wasm_backend"), false);
  applyContentAnalysisConfig(caParam);
}

// Set and lock the Content Analysis prefs for an active ContentAnalysis policy.
// Used for the external agent and for an explicitly-disabled ContentAnalysis policy.
function applyContentAnalysisConfig(caParam) {
  lazy.PoliciesUtils.setPrefIfPresentAndLock(
    caParam,
    "PipePathName",
    caPrefName("pipe_path_name")
  );
  lazy.PoliciesUtils.setPrefIfPresentAndLock(
    caParam,
    "ClientSignature",
    caPrefName("client_signature")
  );
  lazy.PoliciesUtils.setPrefIfPresentAndLock(
    caParam,
    "MaxConnectionsCount",
    caPrefName("max_connections")
  );

  for (let [key, suffix] of [
    ["DefaultResult", "default_result"],
    ["TimeoutResult", "timeout_result"],
  ]) {
    if (key in caParam) {
      let value = caParam[key];
      if (!Number.isInteger(value) || value < 0 || value > 2) {
        lazy.log.error(
          `Non-integer or out of range value for ${key}: ${value}`
        );
        Services.prefs.lockPref(caPrefName(suffix));
      } else {
        lazy.PoliciesUtils.setAndLockPref(caPrefName(suffix), value);
      }
    } else {
      Services.prefs.lockPref(caPrefName(suffix));
    }
  }
  lazy.PoliciesUtils.setPrefIfPresentAndLock(
    caParam,
    "AllowUrlRegexList",
    caPrefName("allow_url_regex_list")
  );
  lazy.PoliciesUtils.setPrefIfPresentAndLock(
    caParam,
    "DenyUrlRegexList",
    caPrefName("deny_url_regex_list")
  );
  lazy.PoliciesUtils.setPrefIfPresentAndLock(
    caParam,
    "AgentName",
    caPrefName("agent_name")
  );
  if ("AgentTimeout" in caParam) {
    if (!Number.isInteger(caParam.AgentTimeout)) {
      lazy.log.error(
        `Non-integer value for AgentTimeout: ${caParam.AgentTimeout}`
      );
    } else {
      lazy.PoliciesUtils.setAndLockPref(
        caPrefName("agent_timeout"),
        caParam.AgentTimeout
      );
    }
  } else {
    Services.prefs.lockPref(caPrefName("agent_timeout"));
  }
  for (let [key, suffix] of [
    ["IsPerUser", "is_per_user"],
    ["ShowBlockedResult", "show_blocked_result"],
    ["BypassForSameTabOperations", "bypass_for_same_tab_operations"],
  ]) {
    if (key in caParam) {
      lazy.PoliciesUtils.setAndLockPref(caPrefName(suffix), !!caParam[key]);
    } else {
      Services.prefs.lockPref(caPrefName(suffix));
    }
  }
  if ("InterceptionPoints" in caParam) {
    for (let [key, suffix] of CA_INTERCEPTION_POINTS) {
      let value = true;
      let point = caParam.InterceptionPoints[key];
      if (point && "Enabled" in point) {
        value = !!point.Enabled;
      }
      lazy.PoliciesUtils.setAndLockPref(
        caPrefName(`interception_point.${suffix}.enabled`),
        value
      );
    }
    for (let [key, suffix] of CA_PLAIN_TEXT_POINTS) {
      let value = true;
      let point = caParam.InterceptionPoints[key];
      if (point && "PlainTextOnly" in point) {
        value = !!point.PlainTextOnly;
      }
      lazy.PoliciesUtils.setAndLockPref(
        caPrefName(`interception_point.${suffix}.plain_text_only`),
        value
      );
    }
  } else {
    for (let [, suffix] of CA_INTERCEPTION_POINTS) {
      Services.prefs.lockPref(
        caPrefName(`interception_point.${suffix}.enabled`)
      );
    }
    for (let [, suffix] of CA_PLAIN_TEXT_POINTS) {
      Services.prefs.lockPref(
        caPrefName(`interception_point.${suffix}.plain_text_only`)
      );
    }
  }
}

// Ensure the Content Analysis service exists (so it can observe policy updates)
// and mark it as controlled by enterprise policy.
function markContentAnalysisPolicyControlled(isControlled) {
  let ca = Cc["@mozilla.org/contentanalysis;1"].getService(
    Ci.nsIContentAnalysis
  );
  ca.isSetByEnterprisePolicy = isControlled;
}
