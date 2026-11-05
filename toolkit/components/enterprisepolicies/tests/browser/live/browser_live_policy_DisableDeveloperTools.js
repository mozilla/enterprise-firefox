/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Covers what is specific to applying DisableDeveloperTools through the live
// policy engine: the dedicated pref (value + lock), the "devtools" feature
// gate, the remote.policy.disabled lock, and the about: pages the policy
// blocks via the content policy.
//
// The pref-driven DevTools behavior is covered in:
// - devtools/startup/tests/browser/browser_disable_devtools_live.js
// - devtools/startup/tests/browser/browser_disable_devtools_live_browser_console.js
// - devtools/startup/tests/browser/browser_disable_devtools_live_browser_toolbox.js

const PREF_DEVTOOLS_DISABLED = "devtools.policy.disabled";
const PREF_REMOTE_DISABLED = "remote.policy.disabled";

// The about: pages that DisableDeveloperTools blocks via the content policy.
const DEVTOOLS_ABOUT_PAGES = [
  "about:debugging",
  "about:devtools-toolbox",
  "about:profiling",
];

async function checkDevToolsAboutPages(blocked) {
  for (const page of DEVTOOLS_ABOUT_PAGES) {
    await EnterprisePolicyTesting.checkBlockedPage(page, blocked);
  }
}

function checkPref(pref, locked, disabled) {
  Assert.equal(
    Services.prefs.prefIsLocked(pref),
    locked,
    `${pref} is ${locked ? "locked" : "unlocked"}`
  );
  Assert.strictEqual(
    Services.prefs.getBoolPref(pref, false),
    disabled,
    `${pref} is ${disabled}`
  );
}

function checkFeature(disabled) {
  Assert.equal(
    Services.policies.isAllowed("devtools"),
    !disabled,
    `devtools feature is ${disabled ? "disallowed" : "allowed"}`
  );
}

// Drive DisableDeveloperTools through its full lifecycle live
add_task(async function test_disable_developer_tools_live_lifecycle() {
  info("No policy: DevTools are fully available");
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );
  checkPref(PREF_DEVTOOLS_DISABLED, false, false);
  checkPref(PREF_REMOTE_DISABLED, false, false);
  checkFeature(false);
  await checkDevToolsAboutPages(false);

  info("Applying DisableDeveloperTools: true");
  await waitForLivePolicyUpdate({ DisableDeveloperTools: true });
  checkPref(PREF_DEVTOOLS_DISABLED, true, true);
  checkPref(PREF_REMOTE_DISABLED, true, true);
  checkFeature(true);
  await checkDevToolsAboutPages(true);

  info("Live-updating DisableDeveloperTools to false (explicit allow)");
  await waitForLivePolicyUpdate({ DisableDeveloperTools: false });
  // Explicitly allowing keeps the pref locked, but to false.
  checkPref(PREF_DEVTOOLS_DISABLED, true, false);
  // The remote pref is only set when disabling, so it is released instead.
  checkPref(PREF_REMOTE_DISABLED, false, false);
  checkFeature(false);
  await checkDevToolsAboutPages(false);

  info("Removing DisableDeveloperTools");
  await waitForLivePolicyUpdate({});
  // Removal unlocks the pref and leaves everything available.
  checkPref(PREF_DEVTOOLS_DISABLED, false, false);
  checkPref(PREF_REMOTE_DISABLED, false, false);
  checkFeature(false);
  await checkDevToolsAboutPages(false);
});
