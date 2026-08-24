/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Live activation of Content Analysis from off, covering the two places that
// used to assume the activation state was fixed at browser startup:
//
//   * the front end, which gated its per-window wiring on isActive once, so a
//     window that already existed when the policy arrived never showed the
//     indicator, and
//   * nsIContentAnalysis::MightBeActive(), which cached the enabled pref in a
//     process-static on first read, so a content process that had already read
//     it kept taking the plain clipboard path and skipped analysis entirely.
//
// Both are only observable when activation happens after the window and the
// content process already exist, which is what these tests set up.

const CA_PREFIX = "browser.contentanalysis.";

const PASTE_RULE = {
  Name: "warn-ai-paste",
  Enabled: true,
  Actions: ["TextPaste"],
  Domains: ["chatgpt.com"],
  Type: "warn",
};

const ca = Cc["@mozilla.org/contentanalysis;1"].getService(
  Ci.nsIContentAnalysis
);

async function startFrom(policies) {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies({ policies });
  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  Services.obs.notifyObservers(null, "EnterprisePolicies:Update");
  await updateApplied;
}

function indicatorShown(win) {
  return win.document.documentElement.hasAttribute("contentanalysisactive");
}

add_task(async function test_indicator_appears_in_existing_windows() {
  await startFrom({});

  // Both windows exist before the policy arrives, which is the case the old
  // startup-time gating got wrong.
  const secondWindow = await BrowserTestUtils.openNewBrowserWindow();

  Assert.ok(
    !indicatorShown(window),
    "no indicator in the original window while inactive"
  );
  Assert.ok(
    !indicatorShown(secondWindow),
    "no indicator in the second window while inactive"
  );

  await waitForLivePolicyUpdate({
    DataLossPrevention: { FallbackResult: "block", Rules: [PASTE_RULE] },
  });

  Assert.ok(ca.isActive, "Content Analysis active after the live update");
  Assert.ok(
    indicatorShown(window),
    "indicator appeared in the original window without a restart"
  );
  Assert.ok(
    indicatorShown(secondWindow),
    "indicator appeared in the second window without a restart"
  );

  // Deactivation must clear it again in every window.
  await waitForLivePolicyUpdate({});

  Assert.ok(!ca.isActive, "Content Analysis inactive again");
  Assert.ok(
    !indicatorShown(window),
    "indicator removed from the original window on deactivation"
  );
  Assert.ok(
    !indicatorShown(secondWindow),
    "indicator removed from the second window on deactivation"
  );

  await BrowserTestUtils.closeWindow(secondWindow);
});

add_task(async function test_indicator_shown_in_a_window_opened_while_active() {
  await startFrom({
    DataLossPrevention: { FallbackResult: "block", Rules: [PASTE_RULE] },
  });

  Assert.ok(ca.isActive, "Content Analysis active");

  const newWindow = await BrowserTestUtils.openNewBrowserWindow();
  Assert.ok(
    indicatorShown(newWindow),
    "a window opened while active shows the indicator"
  );

  await BrowserTestUtils.closeWindow(newWindow);
  await waitForLivePolicyUpdate({});
});

// MightBeActive is the content-process gate for CA-aware clipboard reads. It
// must reflect a live activation in a content process that was already running
// (and had already consulted it) before the policy arrived.
add_task(async function test_might_be_active_live_in_content_process() {
  await startFrom({});

  await BrowserTestUtils.withNewTab(
    "https://example.com/",
    async function (browser) {
      // Read it once while inactive so any per-process caching would be primed
      // with the stale value.
      Assert.ok(
        !(await SpecialPowers.spawn(browser, [], () => {
          return Cc["@mozilla.org/contentanalysis;1"].getService(
            Ci.nsIContentAnalysis
          ).mightBeActive;
        })),
        "mightBeActive is false in the content process while inactive"
      );

      await waitForLivePolicyUpdate({
        DataLossPrevention: { FallbackResult: "block", Rules: [PASTE_RULE] },
      });

      Assert.equal(
        Services.prefs.getBoolPref(CA_PREFIX + "enabled"),
        true,
        "the enabled pref is set in the parent"
      );
      Assert.ok(
        await SpecialPowers.spawn(browser, [], () => {
          return Cc["@mozilla.org/contentanalysis;1"].getService(
            Ci.nsIContentAnalysis
          ).mightBeActive;
        }),
        "mightBeActive turned true in the already-running content process"
      );

      await waitForLivePolicyUpdate({});

      Assert.ok(
        !(await SpecialPowers.spawn(browser, [], () => {
          return Cc["@mozilla.org/contentanalysis;1"].getService(
            Ci.nsIContentAnalysis
          ).mightBeActive;
        })),
        "mightBeActive turned false again after live deactivation"
      );
    }
  );
});
