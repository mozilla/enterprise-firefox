/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Live (no-restart) arbitration between the external ContentAnalysis policy and
// the built-in DataLossPrevention policy, and the C++ backend swap that follows.
//
// Two layers are asserted per transition:
//   * the browser.contentanalysis.* prefs reconcileContentAnalysis computed, and
//   * what ContentAnalysis::MaybeUpdateBackend then did with the live backend,
//     read through backendKindForTest / backendGenerationForTest.
//
// The generation counter is what makes "did NOT swap" observable: prefs the
// existing backend reads live (rules, interception points, default_result) must
// take effect without rebuilding it.

const CA_PREFIX = "browser.contentanalysis.";

const INTERCEPTION_POINTS = [
  "clipboard",
  "download",
  "drag_and_drop",
  "file_upload",
  "print",
];

const PASTE_RULE = {
  Name: "warn-ai-paste",
  Enabled: true,
  Actions: ["TextPaste"],
  Domains: ["chatgpt.com"],
  Type: "warn",
};

const UPLOAD_RULE = {
  Name: "block-cloud-upload",
  Enabled: true,
  Actions: ["FileUpload"],
  Domains: ["dropbox.com"],
  Type: "block",
};

const ca = Cc["@mozilla.org/contentanalysis;1"].getService(
  Ci.nsIContentAnalysis
);

function backendKind() {
  return ca.backendKindForTest;
}

function backendGeneration() {
  return ca.backendGenerationForTest;
}

function serializedRuleNames() {
  let json = Services.prefs.getStringPref(CA_PREFIX + "dlp_rules", "");
  return json ? JSON.parse(json).DLPRules.Rules.map(rule => rule.Name) : [];
}

function assertInterceptionPoints(expectedOn, message) {
  for (let point of INTERCEPTION_POINTS) {
    Assert.equal(
      Services.prefs.getBoolPref(
        `${CA_PREFIX}interception_point.${point}.enabled`,
        false
      ),
      expectedOn.includes(point),
      `${message}: interception_point.${point}.enabled`
    );
  }
}

// Establish a starting policy set, then drive one no-op update through so the
// C++ backend is in sync with the prefs before the transition under test. An
// engine restart re-runs the JS handlers but does not fire
// PolicyUpdatesApplied, and the service is a singleton that outlives each task,
// so without this the backend could still reflect the previous task's policies.
async function startFrom(policies) {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies({ policies });
  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  Services.obs.notifyObservers(null, "EnterprisePolicies:Update");
  await updateApplied;
}

add_task(async function test_live_activation_selects_builtin_backend() {
  await startFrom({});

  Assert.equal(
    backendKind(),
    "none",
    "no live backend while neither policy is present"
  );
  Assert.ok(!ca.isActive, "Content Analysis inactive with no policy");

  await waitForLivePolicyUpdate({
    DataLossPrevention: { FallbackResult: "block", Rules: [PASTE_RULE] },
  });

  Assert.ok(ca.isActive, "Content Analysis active after adding DLP live");
  Assert.equal(
    Services.prefs.getBoolPref(CA_PREFIX + "use_wasm_backend"),
    true,
    "built-in WASM backend selected by policy"
  );
  Assert.equal(
    backendKind(),
    "wasm-module",
    "live backend is the built-in WASM module"
  );
  Assert.deepEqual(
    serializedRuleNames(),
    ["warn-ai-paste"],
    "the DLP rule was delivered"
  );
  assertInterceptionPoints(
    ["clipboard", "drag_and_drop"],
    "TextPaste derives clipboard and drag_and_drop"
  );
});

add_task(async function test_live_rules_edit_does_not_rebuild_backend() {
  await startFrom({
    DataLossPrevention: { FallbackResult: "block", Rules: [PASTE_RULE] },
  });

  Assert.equal(backendKind(), "wasm-module", "starting on the WASM backend");
  const generationBefore = backendGeneration();

  // Same provider, different rules: the backend reads dlp_rules and the
  // interception-point prefs live, so this must not rebuild it.
  await waitForLivePolicyUpdate({
    DataLossPrevention: {
      FallbackResult: "warn",
      Rules: [PASTE_RULE, UPLOAD_RULE],
    },
  });

  Assert.deepEqual(
    serializedRuleNames(),
    ["warn-ai-paste", "block-cloud-upload"],
    "the edited rule set was delivered"
  );
  assertInterceptionPoints(
    ["clipboard", "drag_and_drop", "file_upload"],
    "adding a FileUpload rule enables file_upload"
  );
  Assert.equal(
    Services.prefs.getIntPref(CA_PREFIX + "default_result"),
    1,
    "FallbackResult warn maps to default_result 1"
  );
  Assert.equal(
    backendKind(),
    "wasm-module",
    "still on the built-in WASM backend"
  );
  Assert.equal(
    backendGeneration(),
    generationBefore,
    "a rules-only change did not rebuild the backend"
  );
});

// Diffing case: ContentAnalysis is added while DataLossPrevention is untouched,
// so only the ContentAnalysis callbacks run. reconcileContentAnalysis reads the
// whole active set, so the external agent still takes over.
add_task(async function test_live_adding_external_suppresses_builtin() {
  await startFrom({
    DataLossPrevention: { FallbackResult: "block", Rules: [PASTE_RULE] },
  });

  Assert.equal(backendKind(), "wasm-module", "starting on the WASM backend");
  const generationBefore = backendGeneration();

  await waitForLivePolicyUpdate({
    ContentAnalysis: { Enabled: true },
    DataLossPrevention: { FallbackResult: "block", Rules: [PASTE_RULE] },
  });

  Assert.equal(
    Services.prefs.getBoolPref(CA_PREFIX + "use_wasm_backend"),
    false,
    "external agent wins over the built-in engine"
  );
  Assert.deepEqual(
    serializedRuleNames(),
    [],
    "built-in rules withdrawn while the external agent is authoritative"
  );
  Assert.equal(
    backendKind(),
    "external-agent",
    "live backend swapped to the external agent"
  );
  Assert.greater(
    backendGeneration(),
    generationBefore,
    "the swap rebuilt the backend"
  );
});

// The mirror-image diffing case: ContentAnalysis is removed while
// DataLossPrevention is untouched, so only the ContentAnalysis onRemove runs.
// The built-in engine must reclaim the backend rather than silently stay off.
add_task(async function test_live_removing_external_reactivates_builtin() {
  await startFrom({
    ContentAnalysis: { Enabled: true },
    DataLossPrevention: { FallbackResult: "block", Rules: [UPLOAD_RULE] },
  });

  Assert.equal(
    backendKind(),
    "external-agent",
    "starting on the external agent"
  );
  const generationBefore = backendGeneration();

  await waitForLivePolicyUpdate({
    DataLossPrevention: { FallbackResult: "block", Rules: [UPLOAD_RULE] },
  });

  Assert.equal(
    Services.prefs.getBoolPref(CA_PREFIX + "use_wasm_backend"),
    true,
    "built-in engine reclaims the backend"
  );
  Assert.deepEqual(
    serializedRuleNames(),
    ["block-cloud-upload"],
    "built-in rules delivered again"
  );
  Assert.equal(
    backendKind(),
    "wasm-module",
    "live backend swapped back to the built-in WASM module"
  );
  Assert.greater(
    backendGeneration(),
    generationBefore,
    "the swap back rebuilt the backend"
  );
  assertInterceptionPoints(
    ["file_upload", "drag_and_drop"],
    "interception points derived from the built-in rules again"
  );
});

// Flipping ContentAnalysis.Enabled is an arbitration change even though both
// policies stay present: a disabled ContentAnalysis block does not suppress the
// built-in engine.
add_task(async function test_live_external_enabled_flip_swaps_backend() {
  await startFrom({
    ContentAnalysis: { Enabled: false },
    DataLossPrevention: { FallbackResult: "block", Rules: [PASTE_RULE] },
  });

  Assert.equal(
    backendKind(),
    "wasm-module",
    "a disabled ContentAnalysis policy leaves the built-in engine running"
  );
  let generation = backendGeneration();

  await waitForLivePolicyUpdate({
    ContentAnalysis: { Enabled: true },
    DataLossPrevention: { FallbackResult: "block", Rules: [PASTE_RULE] },
  });

  Assert.equal(
    backendKind(),
    "external-agent",
    "enabling ContentAnalysis hands the backend to the external agent"
  );
  Assert.greater(backendGeneration(), generation, "enabling rebuilt");
  generation = backendGeneration();

  await waitForLivePolicyUpdate({
    ContentAnalysis: { Enabled: false },
    DataLossPrevention: { FallbackResult: "block", Rules: [PASTE_RULE] },
  });

  Assert.equal(
    backendKind(),
    "wasm-module",
    "disabling ContentAnalysis returns the backend to the built-in engine"
  );
  Assert.greater(backendGeneration(), generation, "disabling rebuilt");
  Assert.deepEqual(
    serializedRuleNames(),
    ["warn-ai-paste"],
    "built-in rules delivered once the external agent stands down"
  );
});

// An external agent that stays external still needs a rebuild when its
// connection config changes, because pipe name, signature, per-user flag and
// thread-pool size are baked into the backend at construction.
add_task(async function test_live_external_connection_change_rebuilds() {
  await startFrom({
    ContentAnalysis: { Enabled: true, PipePathName: "live_dlp_pipe_a" },
  });

  Assert.equal(
    backendKind(),
    "external-agent",
    "starting on the external agent"
  );
  let generation = backendGeneration();

  await waitForLivePolicyUpdate({
    ContentAnalysis: { Enabled: true, PipePathName: "live_dlp_pipe_b" },
  });

  Assert.equal(
    Services.prefs.getStringPref(CA_PREFIX + "pipe_path_name"),
    "live_dlp_pipe_b",
    "the new pipe name reached the pref"
  );
  Assert.equal(
    backendKind(),
    "external-agent",
    "still the external agent after a connection change"
  );
  Assert.greater(
    backendGeneration(),
    generation,
    "a changed pipe name rebuilt the external backend"
  );
  generation = backendGeneration();

  // An update that touches nothing the connection depends on must not churn it.
  await waitForLivePolicyUpdate({
    ContentAnalysis: {
      Enabled: true,
      PipePathName: "live_dlp_pipe_b",
      ShowBlockedResult: false,
    },
  });

  Assert.equal(
    backendGeneration(),
    generation,
    "an unrelated ContentAnalysis change left the connection alone"
  );
});

// reconcileContentAnalysis owns every pref the two policies share, so that the
// winner's configuration fully replaces the loser's. Transition live from an
// external agent that set URL filters to a DLP policy that sets none: the
// built-in engine must fall back to the built-in defaults, not inherit the
// agent's filters. Only a live update exercises this -- an engine restart resets
// tracked prefs first, which would mask an inherited value.
add_task(async function test_builtin_does_not_inherit_external_url_filters() {
  const allowList = "https://allowed\\.example\\.com/.*";
  // The shipped default excludes about: pages from analysis; releasing the pref
  // must restore exactly that, rather than clearing it to the empty string.
  const defaultAllowList = Services.prefs
    .getDefaultBranch("")
    .getStringPref(CA_PREFIX + "allow_url_regex_list");
  Assert.notEqual(
    defaultAllowList,
    allowList,
    "the default allow list differs from the one the agent sets"
  );

  await startFrom({
    ContentAnalysis: {
      Enabled: true,
      AllowUrlRegexList: allowList,
      DenyUrlRegexList: "https://denied\\.example\\.com/.*",
    },
  });

  Assert.equal(
    Services.prefs.getStringPref(CA_PREFIX + "allow_url_regex_list", ""),
    allowList,
    "the external agent's allow list is in effect to begin with"
  );

  await waitForLivePolicyUpdate({
    DataLossPrevention: { FallbackResult: "block", Rules: [PASTE_RULE] },
  });

  Assert.equal(backendKind(), "wasm-module", "the built-in engine took over");
  Assert.equal(
    Services.prefs.getStringPref(CA_PREFIX + "deny_url_regex_list", ""),
    "",
    "the external agent's deny list did not carry over"
  );
  Assert.equal(
    Services.prefs.getStringPref(CA_PREFIX + "allow_url_regex_list", ""),
    defaultAllowList,
    "the allow list fell back to its default instead of the agent's value"
  );
});

// Removing every policy must tear the backend down, not leave a live one that a
// stray interception request could still reach.
add_task(async function test_live_deactivation_tears_down_backend() {
  await startFrom({
    DataLossPrevention: { FallbackResult: "block", Rules: [PASTE_RULE] },
  });

  Assert.equal(backendKind(), "wasm-module", "starting on the WASM backend");
  Assert.ok(ca.isActive, "Content Analysis active before deactivation");

  await waitForLivePolicyUpdate({});

  Assert.ok(!ca.isActive, "Content Analysis inactive after removing DLP");
  Assert.equal(
    Services.prefs.getBoolPref(CA_PREFIX + "enabled", false),
    false,
    "the enabled pref was released"
  );
  Assert.equal(backendKind(), "none", "the live backend was torn down");
  Assert.deepEqual(serializedRuleNames(), [], "rules withdrawn");

  // The interception-point prefs are released rather than set to false, so they
  // revert to their built-in defaults (most of which are true). Nothing is
  // intercepted anyway because ShouldCheckReason gates on the enabled pref,
  // which is what keeps a stray request from reaching the dead backend.
  for (let point of INTERCEPTION_POINTS) {
    Assert.ok(
      !Services.prefs.prefIsLocked(
        `${CA_PREFIX}interception_point.${point}.enabled`
      ),
      `interception_point.${point}.enabled was released by policy`
    );
  }
});
