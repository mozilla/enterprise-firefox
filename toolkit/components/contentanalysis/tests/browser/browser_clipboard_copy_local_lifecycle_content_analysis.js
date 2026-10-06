/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// The life of a copy on the local clipboard (keep_blocked_data_for_same_site):
// it is there for the copying tab from the moment the copy starts, so the page
// need not wait for the verdict. An allow verdict commits it to the system clipboard,
// a block or an analysis error keeps it locally behind the placeholder.
// Anything newer on the clipboard supersedes it, as does leaving private browsing.

"use strict";

/* import-globals-from clipboard_copy_helpers.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "clipboard_copy_helpers.js",
  this
);

let mockCA = makeMockContentAnalysis();

add_setup(async function test_setup() {
  mockCA = await mockContentAnalysisService(mockCA);
});

const withCopyEnabled = (prefs, testFn) =>
  withClipboardCopyPrefs(/* keepLocalCopy */ true, prefs, testFn);

// Pasting on the same site while the copy verdict is still pending gets the
// copied data (analyzed as such), and the later block verdict changes nothing
// for the page.
add_task(async function testSameSitePasteBeforeVerdict() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    // Paste the previous contents first, so the paste verdict for this page
    // and clipboard sequence number is cached. The pending copy is served
    // under that same sequence number, so it must not inherit the verdict.
    await startCopyAwaitingVerdict(mockCA, browser, {
      beforeCopy: async () => {
        let pasted = await pasteIntoTarget(
          mockCA,
          browser,
          /* allowPaste */ true
        );
        is(pasted, PREVIOUS_CLIPBOARD_TEXT, "the previous contents pasted");
        is(mockCA.calls.length, 1, "the earlier paste was analyzed");
      },
    });

    // pasteIntoTarget resets the mock, so the paste is answered right away.
    let pasted = await pasteIntoTarget(mockCA, browser, /* allowPaste */ true);
    is(pasted, COPIED_PLAIN_TEXT, "the paste gets the pending copy");
    is(
      mockCA.calls.length,
      1,
      "the paste was analyzed rather than served from the paste cache"
    );
    assertPasteRequest(mockCA.calls[0], COPIED_PLAIN_TEXT, COPY_PAGE_URL);
    is(
      getClipboardText(),
      PREVIOUS_CLIPBOARD_TEXT,
      "the system clipboard is still untouched"
    );

    releaseCopyVerdict(mockCA, /* allow */ false);
    await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);

    pasted = await pasteIntoTarget(mockCA, browser, /* allowPaste */ true);
    is(pasted, COPIED_PLAIN_TEXT, "the paste still gets the blocked copy");

    BrowserTestUtils.removeTab(tab);
  });
});

// The pending copy counts as coming from the copying tab, so
// bypass_for_same_tab_operations skips the paste check for it too.
add_task(async function testSameTabPasteBeforeVerdictBypassesPasteCheck() {
  await withCopyEnabled(
    [["browser.contentanalysis.bypass_for_same_tab_operations", true]],
    async () => {
      let tab = await openCopyTestPage();
      let browser = tab.linkedBrowser;

      await startCopyAwaitingVerdict(mockCA, browser);
      mockCA.clearCalls();

      await clearPasteTarget(browser);
      await SpecialPowers.spawn(browser, [], () => {
        let target = content.document.getElementById("pasteTarget");
        target.focus();
        content.getSelection().collapse(target, 0);
      });
      await BrowserTestUtils.synthesizeKey("v", { accelKey: true }, browser);
      is(
        await getPasteTargetText(browser),
        COPIED_PLAIN_TEXT,
        "the same-tab paste gets the pending copy"
      );
      is(mockCA.calls.length, 0, "the same-tab paste was not analyzed");

      releaseCopyVerdict(mockCA, /* allow */ false);
      await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);

      BrowserTestUtils.removeTab(tab);
    }
  );
});

// Other sites see the previous clipboard contents until the verdict lands.
add_task(async function testCrossSitePasteBeforeVerdictGetsPreviousContents() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    await startCopyAwaitingVerdict(mockCA, tab.linkedBrowser);

    let otherTab = await openCopyTestPage(OTHER_SITE_COPY_PAGE_URL);
    let pasted = await pasteIntoTarget(
      mockCA,
      otherTab.linkedBrowser,
      /* allowPaste */ true
    );
    is(
      pasted,
      PREVIOUS_CLIPBOARD_TEXT,
      "cross-site paste gets the previous clipboard contents"
    );
    is(
      getClipboardText(),
      PREVIOUS_CLIPBOARD_TEXT,
      "other applications see the previous clipboard contents too"
    );

    releaseCopyVerdict(mockCA, /* allow */ false);
    await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);
    is(
      getClipboardText(),
      BLOCKED_REPLACEMENT_TEXT,
      "after the block, other applications see the placeholder"
    );

    BrowserTestUtils.removeTab(otherTab);
    BrowserTestUtils.removeTab(tab);
  });
});

// An allowed verdict commits the copy to the system clipboard and the slot
// hands over to it: everyone now gets the data.
add_task(async function testAllowedVerdictAfterPendingPaste() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    await startCopyAwaitingVerdict(mockCA, browser);

    let pasted = await pasteIntoTarget(mockCA, browser, /* allowPaste */ true);
    is(pasted, COPIED_PLAIN_TEXT, "the paste gets the pending copy");

    releaseCopyVerdict(mockCA, /* allow */ true);
    await waitForClipboardText(COPIED_PLAIN_TEXT);

    pasted = await pasteIntoTarget(mockCA, browser, /* allowPaste */ true);
    is(pasted, COPIED_PLAIN_TEXT, "the paste gets the committed copy");
    is(mockCA.calls.length, 1, "the paste was analyzed");
    assertPasteRequest(mockCA.calls[0], COPIED_PLAIN_TEXT, COPY_PAGE_URL);

    BrowserTestUtils.removeTab(tab);
  });
});

// A second copy while the first is pending supersedes it in the slot too.
add_task(async function testSupersedingCopyReplacesPendingCopy() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    await startCopyAwaitingVerdict(mockCA, browser);

    // Release both verdicts as blocks; the mock waits again for the second.
    let secondInRequest = new Promise(res => {
      mockCA.eventTarget.addEventListener("inAnalyzeContentRequest", res, {
        once: true,
      });
    });
    await SpecialPowers.spawn(browser, [], () => {
      let input = content.document.getElementById("testInput");
      input.focus();
      input.select();
    });
    await BrowserTestUtils.synthesizeKey("c", { accelKey: true }, browser);
    await secondInRequest;

    // Both mock requests are waiting on the same event.
    releaseCopyVerdict(mockCA, /* allow */ false);
    await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);

    let pasted = await pasteIntoTarget(mockCA, browser, /* allowPaste */ true);
    is(pasted, TEXT_FIELD_TEXT, "the paste gets the later copy");

    BrowserTestUtils.removeTab(tab);
  });
});

// A later allowed copy supersedes the blocked one.
add_task(async function testAllowedCopySupersedesBlockedCopy() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    await copyBlocked(mockCA, browser);

    mockCA.setupForTest(/* shouldAllowRequest */ true);
    await SpecialPowers.spawn(browser, [], () => {
      let input = content.document.getElementById("testInput");
      input.focus();
      input.select();
    });
    await BrowserTestUtils.synthesizeKey("c", { accelKey: true }, browser);
    await waitForClipboardText(TEXT_FIELD_TEXT);
    is(getClipboardText(), TEXT_FIELD_TEXT, "the allowed copy went through");

    let pasted = await pasteIntoTarget(mockCA, browser, /* allowPaste */ true);
    is(pasted, TEXT_FIELD_TEXT, "the paste gets the newer, allowed copy");

    BrowserTestUtils.removeTab(tab);
  });
});

// Something else landing on the system clipboard supersedes the blocked copy,
// even for the same site.
add_task(async function testExternalClipboardChangeSupersedesBlockedCopy() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    await copyBlocked(mockCA, browser);
    setClipboardText(EXTERNAL_CLIPBOARD_TEXT);

    let pasted = await pasteIntoTarget(mockCA, browser, /* allowPaste */ true);
    is(
      pasted,
      EXTERNAL_CLIPBOARD_TEXT,
      "the paste gets the newer system clipboard contents"
    );

    BrowserTestUtils.removeTab(tab);
  });
});

// Ctrl+X does not wait for the verdict, so a blocked cut still deletes the
// selection (as in Chromium); the cut text is available to a same-site paste.
add_task(async function testBlockedCutCanBePastedSameSite() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    mockCA.setupForTest(/* shouldAllowRequest */ false);
    setClipboardText(PREVIOUS_CLIPBOARD_TEXT);
    await SpecialPowers.spawn(browser, [], () => {
      let input = content.document.getElementById("testInput");
      input.focus();
      input.select();
    });
    await BrowserTestUtils.synthesizeKey("x", { accelKey: true }, browser);
    let value = await SpecialPowers.spawn(browser, [], () => {
      return content.document.getElementById("testInput").value;
    });
    is(value, "", "the cut deleted the field contents without waiting");
    await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);
    is(getClipboardText(), BLOCKED_REPLACEMENT_TEXT, "the cut was blocked");

    let pasted = await pasteIntoTarget(mockCA, browser, /* allowPaste */ true);
    is(pasted, TEXT_FIELD_TEXT, "the blocked cut's text can be pasted");

    BrowserTestUtils.removeTab(tab);
  });
});

// Blocked data from a private window does not outlive the private session.
add_task(async function testPrivateBrowsingExitDropsBlockedCopy() {
  await withCopyEnabled([], async () => {
    let privateWin = await BrowserTestUtils.openNewBrowserWindow({
      private: true,
    });
    let tab = await openCopyTestPage(COPY_PAGE_URL, privateWin);
    await copyBlocked(mockCA, tab.linkedBrowser);
    await BrowserTestUtils.closeWindow(privateWin);

    let privateWin2 = await BrowserTestUtils.openNewBrowserWindow({
      private: true,
    });
    let tab2 = await openCopyTestPage(COPY_PAGE_URL, privateWin2);
    let pasted = await pasteIntoTarget(
      mockCA,
      tab2.linkedBrowser,
      /* allowPaste */ true
    );
    is(
      pasted,
      BLOCKED_REPLACEMENT_TEXT,
      "the blocked copy was dropped with the private session"
    );
    await BrowserTestUtils.closeWindow(privateWin2);
  });
});

// With the pref off, a blocked copy is just gone.
add_task(async function testKeepBlockedDataPrefOff() {
  await withCopyEnabled(
    [
      [
        "browser.contentanalysis.interception_point.clipboard_copy.keep_blocked_data_for_same_site",
        false,
      ],
    ],
    async () => {
      let tab = await openCopyTestPage();
      let browser = tab.linkedBrowser;

      // Without the local slot there is nothing to paste before the verdict,
      // so the copy waits for it.
      await copyBlocked(mockCA, browser, { waitsForVerdict: true });
      ok(
        !mockCA.calls[0].clipboardCopyKeptLocally,
        "the copy request says the copy is not kept locally"
      );

      let pasted = await pasteIntoTarget(
        mockCA,
        browser,
        /* allowPaste */ true
      );
      is(
        pasted,
        BLOCKED_REPLACEMENT_TEXT,
        "same-site paste gets the placeholder"
      );

      BrowserTestUtils.removeTab(tab);
    }
  );
});

// Unlike execCommand and Ctrl+C, navigator.clipboard.writeText() waits for
// the verdict (its promise is the copy's completion): it rejects for a block
// and resolves for an allow. The copying tab can paste the data meanwhile.
add_task(async function testWriteTextWaitsForVerdict() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    mockCA.setupForTest(
      /* shouldAllowRequest */ false,
      /* waitForEvent */ true
    );
    setClipboardText(PREVIOUS_CLIPBOARD_TEXT);
    let inRequest = new Promise(resolve => {
      mockCA.eventTarget.addEventListener("inAnalyzeContentRequest", resolve, {
        once: true,
      });
    });
    let resultPromise = SpecialPowers.spawn(
      browser,
      [COPIED_PLAIN_TEXT],
      async text => {
        try {
          await content.navigator.clipboard.writeText(text);
          return "resolved";
        } catch (e) {
          return e.name;
        }
      }
    );
    await inRequest;
    is(
      getClipboardText(),
      PREVIOUS_CLIPBOARD_TEXT,
      "the system clipboard is untouched while the verdict is pending"
    );
    is(
      getLocalCopyInfo(mockCA)?.preview,
      COPIED_PLAIN_TEXT_PREVIEW,
      "the written text is already kept for the copying tab"
    );

    releaseCopyVerdict(mockCA, /* allow */ false);
    is(
      await resultPromise,
      "NotAllowedError",
      "writeText() rejects once the copy is blocked"
    );
    await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);

    let pasted = await pasteIntoTarget(mockCA, browser);
    is(pasted, COPIED_PLAIN_TEXT, "the same tab pastes the blocked copy");

    BrowserTestUtils.removeTab(tab);
  });
});

// An analysis error fails closed for the rest of the system, like a block,
// but the copying tab keeps its data.
add_task(async function testAgentErrorKeepsDataForCopyingTab() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    mockCA.setupForTestWithError(Cr.NS_ERROR_NOT_AVAILABLE);
    setClipboardText(PREVIOUS_CLIPBOARD_TEXT);
    // The mock rethrows the error after reporting it, on every request.
    ignoreAllUncaughtExceptions();

    let result = await execCommandCopy(browser);
    is(result, true, "execCommand('copy') returns without waiting");
    // Chrome reads are analyzed too, so the clipboard can only be read once
    // the mock stops erroring.
    await waitForLocalCopyState(
      mockCA,
      Ci.nsIContentAnalysisLocalCopyInfo.BLOCKED
    );
    mockCA.setupForTest(true);
    is(
      getClipboardText(),
      BLOCKED_REPLACEMENT_TEXT,
      "the rest of the system gets the placeholder"
    );

    let pasted = await pasteIntoTarget(mockCA, browser);
    is(pasted, COPIED_PLAIN_TEXT, "the copying tab can still paste the data");

    BrowserTestUtils.removeTab(tab);
  });
});
