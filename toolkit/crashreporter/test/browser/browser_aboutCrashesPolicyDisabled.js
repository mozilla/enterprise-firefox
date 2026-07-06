/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Tests that when the CrashReportsSubmit.Enabled enterprise policy is
 * set to false, about:crashes hides its bulk-submit button and
 * does not render per-row submit buttons for pending reports.
 */

const { EnterprisePolicyTesting, PoliciesPrefTracker } =
  ChromeUtils.importESModule(
    "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
  );

add_task(async function test_aboutCrashes_with_policyDisabled() {
  const appD = make_fake_appdir();
  const crD = appD.clone();
  crD.append("Crash Reports");

  const pendingCrash = addPendingCrashreport(crD, Date.now(), { foo: "bar" });

  PoliciesPrefTracker.start();
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({
    policies: {
      CrashReportsSubmit: {
        Enabled: false,
      },
    },
  });

  registerCleanupFunction(async () => {
    cleanup_fake_appdir();
    PoliciesPrefTracker.stop();
    await EnterprisePolicyTesting.setupPolicyEngineWithJson("");
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:crashes" },
    browser => {
      info(
        "about:crashes loaded under CrashReportsSubmit.Enabled set to false"
      );
      return SpecialPowers.spawn(browser, [pendingCrash], pendingCrash => {
        const doc = content.document;

        const submitAll = doc.getElementById("submitAllUnsubmittedReports");
        Assert.ok(
          submitAll.hidden,
          "submitAllUnsubmittedReports must be hidden under the Disabled policy"
        );

        const unsubmitted = doc.getElementById("reportListUnsubmitted");
        Assert.ok(
          !unsubmitted.classList.contains("hidden"),
          "the unsubmitted crash list is still visible"
        );

        const pendingRow = doc.getElementById(pendingCrash.id);
        Assert.ok(pendingRow, "pending crash row exists");
        Assert.equal(
          pendingRow.cells[2].childElementCount,
          0,
          "pending crash row must not render a submit button under the Disabled policy"
        );
      });
    }
  );
});
