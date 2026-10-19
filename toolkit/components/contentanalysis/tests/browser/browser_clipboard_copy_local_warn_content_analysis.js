/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// A warn verdict for a copy on the local clipboard
// (keep_blocked_data_for_same_site) should not block the page or show a dialog -
// the warn placeholder goes on the system clipboard, the copying tab keeps
// pasting the data, and the user answers later (the DLP panel's
// Release button; here through respondToWarnDialog directly). Allow commits
// the copy. A deny, which only happens on the user's behalf when the copy is
// superseded before the answer (when another copy happens, etc.) turns it
// into an ordinary blocked copy.

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

const { WARN, BLOCKED } = Ci.nsIContentAnalysisLocalCopyInfo;

async function withCopyEnabled(prefs, testFn) {
  try {
    await withClipboardCopyPrefs(/* keepLocalCopy */ true, prefs, testFn);
  } finally {
    // copyFromPage leaves the mock installed as the front end's service.
    mockCA.setupForTest(true);
  }
}

// The warn placeholder goes to everyone but the copying tab, which pastes the
// data (analyzed as such); the front end tracks the token for quit.
add_task(async function testWarnedCopyPlaceholderAndPaste() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    let info = await copyWarned(mockCA, browser);
    is(
      info.preview,
      COPIED_PLAIN_TEXT_PREVIEW,
      "the kept copy is the copied text"
    );
    ok(
      ContentAnalysis.warnDialogRequestTokens.has(info.warnRequestToken),
      "the warning would be denied at quit"
    );

    let pasted = await pasteIntoTarget(mockCA, browser);
    is(pasted, COPIED_PLAIN_TEXT, "same-tab paste gets the warned copy");
    is(mockCA.calls.length, 1, "the paste was analyzed");
    assertPasteRequest(mockCA.calls[0], COPIED_PLAIN_TEXT, COPY_PAGE_URL);

    let otherTab = await openCopyTestPage(COPY_PAGE_URL);
    pasted = await pasteIntoTarget(mockCA, otherTab.linkedBrowser);
    is(pasted, WARN_REPLACEMENT_TEXT, "another tab gets the warn placeholder");
    BrowserTestUtils.removeTab(otherTab);

    let crossSiteTab = await openCopyTestPage(OTHER_SITE_COPY_PAGE_URL);
    pasted = await pasteIntoTarget(mockCA, crossSiteTab.linkedBrowser);
    is(pasted, WARN_REPLACEMENT_TEXT, "another site gets the warn placeholder");
    BrowserTestUtils.removeTab(crossSiteTab);

    is(
      getClipboardText(),
      WARN_REPLACEMENT_TEXT,
      "other applications see the warn placeholder"
    );

    BrowserTestUtils.removeTab(tab);
  });
});

// Allowing commits the copy to the system clipboard.
add_task(async function testWarnedCopyAllow() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    let info = await copyWarned(mockCA, browser);

    let resolved = promiseWarnResolved("user");
    mockCA.respondToWarnDialog(info.warnRequestToken, true);
    await resolved;
    await waitForClipboardText(COPIED_PLAIN_TEXT);
    await waitForNoLocalCopy(mockCA);
    ok(
      !ContentAnalysis.warnDialogRequestTokens.has(info.warnRequestToken),
      "the answered warning is no longer tracked for quit"
    );

    let otherTab = await openCopyTestPage(OTHER_SITE_COPY_PAGE_URL);
    let pasted = await pasteIntoTarget(mockCA, otherTab.linkedBrowser);
    is(pasted, COPIED_PLAIN_TEXT, "everyone gets the committed copy");
    BrowserTestUtils.removeTab(otherTab);

    BrowserTestUtils.removeTab(tab);
  });
});

// Denying makes it an ordinary blocked copy: block placeholder, data still
// pasteable in the copying tab.
add_task(async function testWarnedCopyDeny() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    let info = await copyWarned(mockCA, browser);

    let resolved = promiseWarnResolved("user");
    mockCA.respondToWarnDialog(info.warnRequestToken, false);
    await resolved;
    await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);
    await waitForLocalCopyState(mockCA, BLOCKED);

    let pasted = await pasteIntoTarget(mockCA, browser);
    is(pasted, COPIED_PLAIN_TEXT, "same-tab paste still gets the denied copy");

    BrowserTestUtils.removeTab(tab);
  });
});

// A warned cut deletes its selection like any other cut; the text stays
// pasteable in the tab.
add_task(async function testWarnedCutDeletesSelection() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    mockCA.setupForTest(
      "warn",
      /* waitForEvent */ false,
      /* showDialogs */ true
    );
    setClipboardText(PREVIOUS_CLIPBOARD_TEXT);
    await assertNoDialogs(browser, async () => {
      await selectAllIn(browser, "testInput");
      await BrowserTestUtils.synthesizeKey("x", { accelKey: true }, browser);
      await waitForClipboardText(WARN_REPLACEMENT_TEXT);
    });
    let value = await SpecialPowers.spawn(browser, [], () => {
      return content.document.getElementById("testInput").value;
    });
    is(value, "", "the cut deleted the field contents without waiting");
    is(getLocalCopyInfo(mockCA)?.state, WARN, "the cut awaits the answer");

    let pasted = await pasteIntoTarget(mockCA, browser);
    is(pasted, TEXT_FIELD_TEXT, "the warned cut's text can be pasted");

    BrowserTestUtils.removeTab(tab);
  });
});

// navigator.clipboard.writeText() resolves for a warned copy: from the page's
// point of view the copy happened.
add_task(async function testWarnedWriteTextResolves() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    mockCA.setupForTest(
      "warn",
      /* waitForEvent */ false,
      /* showDialogs */ true
    );
    setClipboardText(PREVIOUS_CLIPBOARD_TEXT);
    let result = await SpecialPowers.spawn(
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
    is(result, "resolved", "writeText() resolves for a warned copy");
    await waitForClipboardText(WARN_REPLACEMENT_TEXT);
    await waitForLocalCopyState(mockCA, WARN);
    is(
      getLocalCopyInfo(mockCA).preview,
      COPIED_PLAIN_TEXT_PREVIEW,
      "the written text is the kept copy"
    );

    BrowserTestUtils.removeTab(tab);
  });
});

// A newer copy while the warning is undecided cancels it; the slot then holds
// the new copy.
add_task(async function testWarnedCopySupersededByCopy() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    let info = await copyWarned(mockCA, browser);

    let cancelled = promiseWarnResolved("cancel");
    mockCA.setupForTest(
      /* shouldAllowRequest */ true,
      /* waitForEvent */ true,
      /* showDialogs */ true
    );
    let inRequest = new Promise(resolve => {
      mockCA.eventTarget.addEventListener("inAnalyzeContentRequest", resolve, {
        once: true,
      });
    });
    await selectAllIn(browser, "testInput");
    await BrowserTestUtils.synthesizeKey("c", { accelKey: true }, browser);
    await cancelled;
    await inRequest;
    let newInfo = getLocalCopyInfo(mockCA);
    is(
      newInfo.state,
      Ci.nsIContentAnalysisLocalCopyInfo.PENDING,
      "the slot now holds the new, pending copy"
    );
    is(
      newInfo.preview,
      TEXT_FIELD_TEXT_PREVIEW,
      "the kept copy is the new copy"
    );
    ok(
      !ContentAnalysis.warnDialogRequestTokens.has(info.warnRequestToken),
      "the cancelled warning is no longer tracked for quit"
    );

    releaseCopyVerdict(mockCA, /* allow */ true);
    await waitForClipboardText(TEXT_FIELD_TEXT);
    await waitForNoLocalCopy(mockCA);

    BrowserTestUtils.removeTab(tab);
  });
});

// Something else landing on the system clipboard while the warning is
// undecided cancels it too, and is left alone.
add_task(async function testWarnedCopySupersededExternally() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    await copyWarned(mockCA, browser);

    let cancelled = promiseWarnResolved("cancel");
    setClipboardText(EXTERNAL_CLIPBOARD_TEXT);
    ok(!getLocalCopyInfo(mockCA), "the warned copy is gone");
    await cancelled;
    is(
      getClipboardText(),
      EXTERNAL_CLIPBOARD_TEXT,
      "the external clipboard contents were left alone"
    );

    let pasted = await pasteIntoTarget(mockCA, browser);
    is(
      pasted,
      EXTERNAL_CLIPBOARD_TEXT,
      "the copying tab pastes the newer contents too"
    );

    BrowserTestUtils.removeTab(tab);
  });
});

// Warned data from a private window does not outlive the private session;
// the warning is cancelled with it.
add_task(async function testPrivateBrowsingExitCancelsWarn() {
  await withCopyEnabled([], async () => {
    let privateWin = await BrowserTestUtils.openNewBrowserWindow({
      private: true,
    });
    let tab = await openCopyTestPage(COPY_PAGE_URL, privateWin);
    await copyWarned(mockCA, tab.linkedBrowser);

    let cancelled = promiseWarnResolved("cancel");
    await BrowserTestUtils.closeWindow(privateWin);
    await cancelled;
    ok(!getLocalCopyInfo(mockCA), "the warned copy was dropped");
    is(
      getClipboardText(),
      WARN_REPLACEMENT_TEXT,
      "the placeholder stays on the system clipboard"
    );
  });
});

// An undecided warning is denied when the application quits, as the warn
// dialog's would be.
add_task(async function testWarnedCopyDeniedAtQuit() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    let info = await copyWarned(mockCA, browser);

    await ContentAnalysis.observe(null, "quit-application-granted", "");
    await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);
    await waitForLocalCopyState(mockCA, BLOCKED);
    ok(
      !ContentAnalysis.warnDialogRequestTokens.has(info.warnRequestToken),
      "the warning is no longer tracked"
    );

    BrowserTestUtils.removeTab(tab);
  });
});
