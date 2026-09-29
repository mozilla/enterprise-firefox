/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// The local clipboard (keep_blocked_data_for_same_site) only exists in
// Enterprise builds. Elsewhere, setting its pref must change nothing: copies
// still wait for the verdict, nothing is kept for the copying tab, and a
// blocked copy leaves only the placeholder, even for a paste back into the
// same tab.

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

// A blocked copy waits for its verdict and is not kept: the copying tab
// pastes the placeholder like everyone else.
add_task(async function testBlockedCopyNotKeptWithPrefSet() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    await copyBlocked(mockCA, browser, { waitsForVerdict: true });
    ok(!getLocalCopyInfo(mockCA), "nothing is kept for the copying tab");

    let pasted = await pasteIntoTarget(mockCA, browser);
    is(
      pasted,
      BLOCKED_REPLACEMENT_TEXT,
      "the copying tab pastes the placeholder"
    );

    BrowserTestUtils.removeTab(tab);
  });
});

// While the verdict is pending the copy is not kept either, and the page's
// execCommand("copy") has not returned.
add_task(async function testPendingCopyNotKeptWithPrefSet() {
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
    let copyReturned = false;
    let copyPromise = execCommandCopy(browser).then(result => {
      copyReturned = true;
      return result;
    });
    await inRequest;
    ok(!copyReturned, "execCommand('copy') waits for the verdict");
    ok(
      !getLocalCopyInfo(mockCA),
      "nothing is kept while the verdict is pending"
    );
    is(
      getClipboardText(),
      PREVIOUS_CLIPBOARD_TEXT,
      "the system clipboard is untouched while the verdict is pending"
    );

    releaseCopyVerdict(mockCA, /* allow */ false);
    is(await copyPromise, false, "execCommand('copy') reports the block");
    await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);
    ok(!getLocalCopyInfo(mockCA), "nothing is kept after the block");

    BrowserTestUtils.removeTab(tab);
  });
});
