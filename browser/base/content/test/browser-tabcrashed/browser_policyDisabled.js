/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PAGE =
  "data:text/html,<html><body>A%20regular,%20everyday,%20normal%20page.";

const { EnterprisePolicyTesting, PoliciesPrefTracker } =
  ChromeUtils.importESModule(
    "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
  );

const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs"
);

// On debug builds, crashing tabs results in much thinking, which
// slows down the test and results in intermittent test timeouts,
// so we'll pump up the expected timeout for this test.
requestLongerTimeout(2);

/**
 * When the CrashReportsSubmit.Enabled enterprise policy is set to false,
 * the about:tabcrashed page must not surface any crash report submission UI
 * and TabCrashHandler.maybeSendCrashReport must short-circuit before
 * invoking CrashSubmit.submit.
 */
add_task(async function test_policyDisabled_hides_report_ui() {
  PoliciesPrefTracker.start();
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({
    policies: {
      CrashReportsSubmit: {
        Enabled: false,
      },
    },
  });

  let submitCalls = 0;
  let { CrashSubmit } = ChromeUtils.importESModule(
    "moz-src:///toolkit/crashreporter/CrashSubmit.sys.mjs"
  );
  let originalSubmit = CrashSubmit.submit;
  CrashSubmit.submit = function () {
    submitCalls++;
    return Promise.resolve();
  };

  registerCleanupFunction(async () => {
    CrashSubmit.submit = originalSubmit;
    await EnterprisePolicyTesting.setupPolicyEngineWithJson("");
    PoliciesPrefTracker.stop();
  });

  await BrowserTestUtils.withNewTab(
    {
      gBrowser,
      url: PAGE,
    },
    async function (browser) {
      // Make sure we've flushed the browser messages so that
      // we can restore it.
      await TabStateFlusher.flush(browser);

      await BrowserTestUtils.crashFrame(browser);

      let doc = browser.contentDocument;

      Assert.ok(
        !doc.documentElement.classList.contains("crashDumpAvailable"),
        "crashDumpAvailable class should not be set under the Disabled policy"
      );

      let options = doc.getElementById("options");
      Assert.ok(
        options.hidden,
        "Report submission options should be hidden under the Disabled policy"
      );

      // Send a restoreTab message; even with sendReport true in the UI's
      // hypothetical state, maybeSendCrashReport must not invoke CrashSubmit.
      doc.getElementById("sendReport").checked = true;
      let restoreButton = doc.getElementById("restoreTab");
      restoreButton.click();

      await BrowserTestUtils.browserLoaded(browser, false, PAGE);

      Assert.equal(
        submitCalls,
        0,
        "CrashSubmit.submit must not be invoked while the Disabled policy is active"
      );
    }
  );
});
