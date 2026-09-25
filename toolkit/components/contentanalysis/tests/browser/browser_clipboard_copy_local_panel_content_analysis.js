/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// The UI for copies on the local clipboard (keep_blocked_data_for_same_site)
// should have no busy, block or warn dialog. Instead, a dot should be shown
// on the DLP toolbar button while there is something to know about (in every window).
// The DLP panel should have a preview of the copy and, for a warn verdict, a
// Release button in that panel.

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

const { PENDING, BLOCKED } = Ci.nsIContentAnalysisLocalCopyInfo;

async function withCopyEnabled(prefs, testFn) {
  try {
    await withClipboardCopyPrefs(/* keepLocalCopy */ true, prefs, testFn);
  } finally {
    // copyFromPage leaves the mock installed as the front end's service.
    mockCA.setupForTest(true);
  }
}

function indicators(win = window) {
  return Array.from(
    win.document.getElementsByClassName("content-analysis-indicator")
  );
}

function getIndicator(win = window) {
  return indicators(win).find(el => el.checkVisibility());
}

function hasDot(win = window) {
  return indicators(win).every(
    el => el.getAttribute("badge-status") == "local-copy"
  );
}

function waitForDot(expected, win = window) {
  return TestUtils.waitForCondition(
    () => hasDot(win) === expected,
    `waiting for the indicator dot to be ${expected ? "shown" : "hidden"}`
  );
}

function panelNode(id, win = window) {
  return PanelMultiView.getViewNode(win.document, id);
}

async function openPanel(win = window) {
  let view = panelNode("content-analysis-panel", win);
  let shown = BrowserTestUtils.waitForEvent(view, "ViewShown");
  ContentAnalysis.showPanel(getIndicator(win), win.PanelUI);
  await shown;
  return view;
}

async function closePanel(view) {
  let panel = view.closest("panel");
  ok(panel, "the panel is still open");
  if (!panel) {
    return;
  }
  let hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await hidden;
}

function checkPanelEntry(
  { statusId, preview, previewId, host, release },
  win = window
) {
  ok(
    !panelNode("content-analysis-local-copy", win).hidden,
    "the panel has a local copy entry"
  );
  is(
    panelNode("content-analysis-local-copy-status", win).getAttribute(
      "data-l10n-id"
    ),
    statusId,
    "the entry has the expected status"
  );
  let previewNode = panelNode("content-analysis-local-copy-preview", win);
  if (previewId) {
    is(
      previewNode.getAttribute("data-l10n-id"),
      previewId,
      "the entry shows the preview fallback"
    );
  } else {
    ok(!previewNode.hasAttribute("data-l10n-id"), "the preview is the text");
    is(previewNode.textContent, preview, "the entry shows the preview");
  }
  let source = panelNode("content-analysis-local-copy-source", win);
  is(
    source.getAttribute("data-l10n-id"),
    "content-analysis-local-copy-source",
    "the entry names the source"
  );
  is(
    JSON.parse(source.getAttribute("data-l10n-args")).host,
    host,
    "the entry names the copying host"
  );
  is(
    panelNode("content-analysis-local-copy-buttons", win).hidden,
    !release,
    `the Release button is ${release ? "shown" : "hidden"}`
  );
}

// While the verdict is pending: no busy dialog, a dot, a Pending entry, and
// the copying tab already pastes the data.
add_task(async function testPendingCopy() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    await assertNoDialogs(browser, async () => {
      await startCopyAwaitingVerdict(mockCA, browser, { showDialogs: true });
    });
    ok(hasDot(), "the indicator has a dot while the copy is pending");
    let info = getLocalCopyInfo(mockCA);
    is(info.state, PENDING, "the local copy is pending");
    is(
      info.preview,
      COPIED_PLAIN_TEXT_PREVIEW,
      "the preview is the copied text"
    );
    is(info.sourceHost, "example.com", "the source host is the page's");
    is(info.warnRequestToken, "", "a pending copy has no warn token");
    ok(
      mockCA.calls[0].clipboardCopyKeptLocally,
      "the copy request says the copy is kept locally"
    );

    let view = await openPanel();
    checkPanelEntry({
      statusId: "content-analysis-local-copy-status-pending",
      preview: COPIED_PLAIN_TEXT_PREVIEW,
      host: "example.com",
      release: false,
    });
    await closePanel(view);

    let pasted = await pasteIntoTarget(mockCA, browser);
    is(pasted, COPIED_PLAIN_TEXT, "same-tab paste gets the pending copy");
    is(
      getClipboardText(),
      PREVIOUS_CLIPBOARD_TEXT,
      "other applications still see the previous clipboard contents"
    );
    is(getLocalCopyInfo(mockCA).state, PENDING, "the copy is still pending");

    releaseCopyVerdict(mockCA, /* allow */ true);
    await waitForClipboardText(COPIED_PLAIN_TEXT);
    await waitForNoLocalCopy(mockCA);
    await waitForDot(false);

    BrowserTestUtils.removeTab(tab);
  });
});

// A blocked copy: no dialog, a dot until the panel is opened, a Blocked
// entry, and nothing once the clipboard moves on.
add_task(async function testBlockedCopy() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    await copyBlocked(mockCA, browser);
    await waitForLocalCopyState(mockCA, BLOCKED);
    ok(hasDot(), "the indicator has a dot for the blocked copy");

    let view = await openPanel();
    checkPanelEntry({
      statusId: "content-analysis-local-copy-status-blocked",
      preview: COPIED_PLAIN_TEXT_PREVIEW,
      host: "example.com",
      release: false,
    });
    ok(!hasDot(), "opening the panel clears the dot for a blocked copy");
    await closePanel(view);

    setClipboardText(EXTERNAL_CLIPBOARD_TEXT);
    ok(
      !getLocalCopyInfo(mockCA),
      "the local copy is gone once the clipboard moves"
    );
    view = await openPanel();
    ok(
      panelNode("content-analysis-local-copy").hidden,
      "the panel has no entry any more"
    );
    await closePanel(view);

    BrowserTestUtils.removeTab(tab);
  });
});

// A warned copy has a Flagged entry with a Release button; releasing commits
// the copy and the entry leaves the open panel.
add_task(async function testWarnedCopyReleaseFromPanel() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    let info = await copyWarned(mockCA, browser);
    ok(hasDot(), "the indicator has a dot for the warned copy");

    let view = await openPanel();
    checkPanelEntry({
      statusId: "content-analysis-local-copy-status-warn",
      preview: COPIED_PLAIN_TEXT_PREVIEW,
      host: "example.com",
      release: true,
    });
    let resolved = promiseWarnResolved("user");
    panelNode("content-analysis-local-copy-release").click();
    await resolved;
    await waitForClipboardText(COPIED_PLAIN_TEXT);
    await waitForNoLocalCopy(mockCA);
    await waitForDot(false);
    ok(
      panelNode("content-analysis-local-copy").hidden,
      "the entry left the open panel once the copy was committed"
    );
    ok(
      !ContentAnalysis.warnDialogRequestTokens.has(info.warnRequestToken),
      "the answered warning is no longer tracked for quit"
    );
    await closePanel(view);

    BrowserTestUtils.removeTab(tab);
  });
});

// With show_blocked_result off there is no dot for a blocked copy, but the
// panel still has the entry.
add_task(async function testShowBlockedResultOff() {
  await withCopyEnabled(
    [["browser.contentanalysis.show_blocked_result", false]],
    async () => {
      let tab = await openCopyTestPage();
      let browser = tab.linkedBrowser;

      await copyBlocked(mockCA, browser);
      await waitForLocalCopyState(mockCA, BLOCKED);
      ok(!hasDot(), "no dot for a blocked copy when not showing blocks");

      let view = await openPanel();
      checkPanelEntry({
        statusId: "content-analysis-local-copy-status-blocked",
        preview: COPIED_PLAIN_TEXT_PREVIEW,
        host: "example.com",
        release: false,
      });
      await closePanel(view);

      BrowserTestUtils.removeTab(tab);
    }
  );
});

// Every browser window shows the dot, and opening the panel in any of them
// counts as having seen a blocked copy.
add_task(async function testTwoWindows() {
  await withCopyEnabled([], async () => {
    let otherWin = await BrowserTestUtils.openNewBrowserWindow();
    let tab = await openCopyTestPage(COPY_PAGE_URL, window);
    let browser = tab.linkedBrowser;

    await copyBlocked(mockCA, browser);
    await waitForLocalCopyState(mockCA, BLOCKED);
    await waitForDot(true, window);
    await waitForDot(true, otherWin);

    let view = await openPanel(otherWin);
    checkPanelEntry(
      {
        statusId: "content-analysis-local-copy-status-blocked",
        preview: COPIED_PLAIN_TEXT_PREVIEW,
        host: "example.com",
        release: false,
      },
      otherWin
    );
    ok(
      !hasDot(otherWin),
      "the dot is gone in the window that opened the panel"
    );
    ok(!hasDot(window), "and in the other window");
    await closePanel(view);

    BrowserTestUtils.removeTab(tab);
    await BrowserTestUtils.closeWindow(otherWin);
  });
});

// A copy with no plain text gets the "Formatted content" fallback instead of
// a preview. HTML has to be analyzed for such a copy to reach the agent.
add_task(async function testFormattedOnlyPreview() {
  await withCopyEnabled(
    [
      [
        "browser.contentanalysis.interception_point.clipboard_copy.plain_text_only",
        false,
      ],
    ],
    async () => {
      let tab = await openCopyTestPage();
      let browser = tab.linkedBrowser;

      mockCA.setupForTest(
        /* shouldAllowRequest */ false,
        /* waitForEvent */ true,
        /* showDialogs */ true
      );
      setClipboardText(PREVIOUS_CLIPBOARD_TEXT);
      let inRequest = new Promise(resolve => {
        mockCA.eventTarget.addEventListener(
          "inAnalyzeContentRequest",
          resolve,
          { once: true }
        );
      });
      // Like writeText(), write()'s promise waits for the verdict.
      let resultPromise = SpecialPowers.spawn(browser, [], async () => {
        const item = new content.ClipboardItem({
          "text/html": new content.Blob(["<b>only markup</b>"], {
            type: "text/html",
          }),
        });
        try {
          await content.navigator.clipboard.write([item]);
          return "resolved";
        } catch (e) {
          return e.name;
        }
      });
      await inRequest;

      let info = getLocalCopyInfo(mockCA);
      is(info.state, PENDING, "the copy is pending");
      is(info.preview, "", "a copy without plain text has no preview");
      let view = await openPanel();
      checkPanelEntry({
        statusId: "content-analysis-local-copy-status-pending",
        previewId: "content-analysis-local-copy-formatted-content",
        host: "example.com",
        release: false,
      });
      await closePanel(view);

      releaseCopyVerdict(mockCA, /* allow */ false);
      is(await resultPromise, "NotAllowedError", "write() rejects on block");
      await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);

      BrowserTestUtils.removeTab(tab);
    }
  );
});

// Long text is collapsed to one line and ellipsized for the preview.
add_task(async function testLongPreviewIsEllipsized() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    const longText =
      "One\n\nx  with   extra spaces and then more words to " +
      "exceed the preview length by a fair margin";
    await SpecialPowers.spawn(browser, [longText], text => {
      let textArea = content.document.getElementById("testTextArea");
      textArea.value = text;
      textArea.focus();
      textArea.select();
    });
    mockCA.setupForTest(
      /* shouldAllowRequest */ false,
      /* waitForEvent */ false,
      /* showDialogs */ true
    );
    setClipboardText(PREVIOUS_CLIPBOARD_TEXT);
    await BrowserTestUtils.synthesizeKey("c", { accelKey: true }, browser);
    await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);

    let preview = getLocalCopyInfo(mockCA).preview;
    info(`preview: "${preview}"`);
    ok(
      preview.startsWith("One x w"),
      "whitespace runs and line breaks collapse to single spaces"
    );
    ok(preview.endsWith("…"), "the preview is ellipsized");
    is(
      Array.from(preview).length,
      9,
      "the preview is 8 code points plus the ellipsis"
    );

    BrowserTestUtils.removeTab(tab);
  });
});
