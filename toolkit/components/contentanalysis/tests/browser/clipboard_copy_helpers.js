/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// Helpers shared by the clipboard copy content analysis tests
// (browser_clipboard_copy_*.js).
// Helpers that drive the mock content analysis service take it as their first
// argument, since each test file owns its own mock.

"use strict";

const COPY_PAGE_PATH =
  "/browser/toolkit/components/contentanalysis/tests/browser/clipboard_copy.html";
const COPY_PAGE_URL = "https://example.com" + COPY_PAGE_PATH;
const OTHER_SITE_COPY_PAGE_URL = "https://example.org" + COPY_PAGE_PATH;

// What selecting all of #copySource in clipboard_copy.html puts on the
// clipboard, and the value of its #testInput.
const COPIED_PLAIN_TEXT = "Some bold text";
const COPIED_PLAIN_TEXT_PREVIEW = "Some bol…";
const TEXT_FIELD_TEXT = "Text field contents";
const TEXT_FIELD_TEXT_PREVIEW = "Text fie…";
const PREVIOUS_CLIPBOARD_TEXT = "Previous clipboard contents";
const EXTERNAL_CLIPBOARD_TEXT = "Text from another application";

const PLACEHOLDER_L10N = new Localization(
  ["branding/brand.ftl", "toolkit/contentanalysis/contentanalysis.ftl"],
  true
);
const BLOCKED_REPLACEMENT_TEXT = PLACEHOLDER_L10N.formatValueSync(
  "contentanalysis-clipboard-copy-blocked-replacement"
);

const KEEP_LOCAL_COPY_PREF =
  "browser.contentanalysis.interception_point.clipboard_copy.keep_blocked_data_for_same_site";

// A chrome write with no window context, so it is not analyzed.
function setClipboardText(clipboardString) {
  const trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(
    Ci.nsITransferable
  );
  trans.init(null);
  trans.addDataFlavor("text/plain");
  const str = Cc["@mozilla.org/supports-string;1"].createInstance(
    Ci.nsISupportsString
  );
  str.data = clipboardString;
  trans.setTransferData("text/plain", str);
  Services.clipboard.setData(trans, null, Ci.nsIClipboard.kGlobalClipboard);
}

// A parent-process read, like any other application would do: never sees
// data kept on the local clipboard. Returns "" if the read fails, which it
// does when the mock is set up to error, since chrome reads are analyzed too.
function getClipboardText() {
  const trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(
    Ci.nsITransferable
  );
  trans.init(null);
  trans.addDataFlavor("text/plain");
  let data = {};
  try {
    Services.clipboard.getData(
      trans,
      Ci.nsIClipboard.kGlobalClipboard,
      window.browsingContext.currentWindowContext
    );
    trans.getTransferData("text/plain", data);
  } catch (e) {
    return "";
  }
  return data.value.QueryInterface(Ci.nsISupportsString).data;
}

function waitForClipboardText(expected) {
  return TestUtils.waitForCondition(
    () => getClipboardText() === expected,
    `waiting for clipboard to contain "${expected}"`
  );
}

// Runs testFn with copy interception on and the local clipboard
// (keep_blocked_data_for_same_site) as given.
async function withClipboardCopyPrefs(keepLocalCopy, prefs, testFn) {
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.contentanalysis.interception_point.clipboard_copy.enabled",
        true,
      ],
      [KEEP_LOCAL_COPY_PREF, keepLocalCopy],
      ["dom.events.testing.asyncClipboard", true],
      ...prefs,
    ],
  });
  try {
    await testFn();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
}

async function openCopyTestPage(url = COPY_PAGE_URL, win = window) {
  let tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, url);
  await SimpleTest.promiseFocus(tab.linkedBrowser);
  return tab;
}

function waitForCACalls(mockCA, count) {
  return TestUtils.waitForCondition(
    () => mockCA.calls.length >= count,
    `waiting for ${count} content analysis call(s)`
  );
}

async function selectAllIn(browser, elementId) {
  await SpecialPowers.spawn(browser, [elementId], elementId => {
    let element = content.document.getElementById(elementId);
    element.focus();
    element.select();
  });
}

function assertPasteRequest(request, expectedText, expectedUrl) {
  is(request.url.spec, expectedUrl, "paste request has correct URL");
  is(
    request.analysisType,
    Ci.nsIContentAnalysisRequest.eBulkDataEntry,
    "paste request has correct analysisType"
  );
  is(
    request.reason,
    Ci.nsIContentAnalysisRequest.eClipboardPaste,
    "paste request has correct reason"
  );
  is(request.textContent, expectedText, "paste request textContent matches");
}

// Runs aFn and checks that no tab-modal dialog (busy, block or warn) opened
// on browser meanwhile, waiting past the busy dialog's blocking timeout.
async function assertNoDialogs(browser, aFn) {
  let dialogOpened = false;
  let listener = () => {
    dialogOpened = true;
  };
  browser.addEventListener("DOMWillOpenModalDialog", listener);
  try {
    await aFn();
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(resolve => setTimeout(resolve, 500));
  } finally {
    browser.removeEventListener("DOMWillOpenModalDialog", listener);
  }
  ok(!dialogOpened, "no content analysis dialog was shown for the copy");
}

// Selects #copySource and runs execCommand("copy") in the page, returning
// what execCommand returned.
function execCommandCopy(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    content.wrappedJSObject.selectCopySource();
    return content.document.execCommand("copy");
  });
}

// Private function that sets the mock up, calls execCommand("copy") and
// checks what it returned: should be true when the copy does not wait
// for the verdict (the local clipboard) and false for a blocked copy that does.
// With holdVerdict, returns once the mock is holding the verdict, and the caller
// is responsible for calling releaseCopyVerdict() to finish the mock analysis.
async function runCopy(
  mockCA,
  browser,
  { verdict, holdVerdict, showDialogs, returnsAtOnce = true }
) {
  mockCA.setupForTest(verdict, holdVerdict, showDialogs);
  let inRequest = new Promise(resolve => {
    mockCA.eventTarget.addEventListener("inAnalyzeContentRequest", resolve, {
      once: true,
    });
  });
  let result = await execCommandCopy(browser);
  is(
    result,
    returnsAtOnce,
    returnsAtOnce
      ? "execCommand('copy') returns without waiting"
      : "execCommand('copy') reports the blocked copy it waited for"
  );
  if (holdVerdict) {
    await inRequest;
  }
}

// Copies from the page and lets the mock answer with `verdict` (true, false or
// "warn") on its own, driving the front end as in production (showDialogs)
// so dialogs, dot and panel react. Returns once the mock has been asked; the
// verdict may still be on its way. Only for use with the local clipboard,
// where the copy returns before the verdict.
async function copyFromPage(
  mockCA,
  browser,
  verdict,
  { showDialogs = true } = {}
) {
  setClipboardText(PREVIOUS_CLIPBOARD_TEXT);
  await runCopy(mockCA, browser, { verdict, holdVerdict: false, showDialogs });
  await waitForCACalls(mockCA, 1);
}

// Copies from the page and returns once the mock is holding its
// verdict; the caller must release it with releaseCopyVerdict().
// showDialogs drives the front end (dot, panel) in the meantime;
// beforeCopy runs after the clipboard is seeded but before the mock is set up
// for the copy, so it may use the mock itself (for a paste, say).
async function startCopyAwaitingVerdict(
  mockCA,
  browser,
  { showDialogs = false, beforeCopy } = {}
) {
  setClipboardText(PREVIOUS_CLIPBOARD_TEXT);
  if (beforeCopy) {
    await beforeCopy();
  }
  await runCopy(mockCA, browser, {
    verdict: false,
    holdVerdict: true,
    showDialogs,
  });
  is(mockCA.calls.length, 1, "the copy is being analyzed");
  is(
    getClipboardText(),
    PREVIOUS_CLIPBOARD_TEXT,
    "the system clipboard is untouched while the verdict is pending"
  );
}

// Copies from the page while the mock blocks it, and checks that only the
// placeholder reached the system clipboard and, with the local clipboard on,
// that no dialog was shown. With the local clipboard off the copy waits for
// the verdict (waitsForVerdict), and the mock is not asked to drive the front
// end, so there is no dialog check.
async function copyBlocked(
  mockCA,
  browser,
  { expectedCalls = 1, waitsForVerdict = false } = {}
) {
  let checkBlocked = async () => {
    await waitForCACalls(mockCA, expectedCalls);
    is(mockCA.calls.length, expectedCalls, "the copy was analyzed");
    is(
      mockCA.calls[0].reason,
      Ci.nsIContentAnalysisRequest.eClipboardCopy,
      "the copy request has the copy reason"
    );
    await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);
  };
  if (waitsForVerdict) {
    setClipboardText(PREVIOUS_CLIPBOARD_TEXT);
    await runCopy(mockCA, browser, {
      verdict: false,
      holdVerdict: false,
      showDialogs: false,
      returnsAtOnce: false,
    });
    await checkBlocked();
    return;
  }
  await assertNoDialogs(browser, async () => {
    await copyFromPage(mockCA, browser, /* verdict */ false);
    await checkBlocked();
  });
}

// The mock reads shouldAllowRequest when it builds the response, so a paste
// in between may have changed it; set the verdict explicitly.
function releaseCopyVerdict(mockCA, allow) {
  mockCA.shouldAllowRequest = allow;
  mockCA.eventTarget.dispatchEvent(
    new CustomEvent("returnContentAnalysisResponse")
  );
}

async function clearPasteTarget(browsingContext) {
  await SpecialPowers.spawn(browsingContext, [], () => {
    content.document.getElementById("pasteTarget").textContent = "";
  });
}

function getPasteTargetText(browsingContext) {
  return SpecialPowers.spawn(browsingContext, [], () => {
    return content.document.getElementById("pasteTarget").textContent;
  });
}

// Ctrl+V into the contenteditable #pasteTarget of a browser or browsing
// context, with the mock reset to answer the paste with allowPaste (which also
// stops it driving the front end). Pastes from content processes wait for the
// verdict, so the target has its final contents on return.
async function pasteIntoTarget(mockCA, browsingContext, allowPaste = true) {
  mockCA.setupForTest(allowPaste);
  await clearPasteTarget(browsingContext);
  await SpecialPowers.spawn(browsingContext, [], () => {
    let target = content.document.getElementById("pasteTarget");
    target.focus();
    // focus() is a no-op if the target already has focus, but a copy since
    // then may have moved the selection elsewhere.
    content.getSelection().collapse(target, 0);
  });
  await BrowserTestUtils.synthesizeKey(
    "v",
    { accelKey: true },
    browsingContext
  );
  return getPasteTargetText(browsingContext);
}

// What the clipboard is keeping locally, or null. Goes through the mock,
// which forwards to the real service.
function getLocalCopyInfo(mockCA) {
  return mockCA.getLocalClipboardCopyInfo();
}

function waitForLocalCopyState(mockCA, expectedState) {
  return TestUtils.waitForCondition(
    () => getLocalCopyInfo(mockCA)?.state === expectedState,
    `waiting for the local copy to be in state ${expectedState}`
  );
}

function waitForNoLocalCopy(mockCA) {
  return TestUtils.waitForCondition(
    () => !getLocalCopyInfo(mockCA),
    "waiting for the local copy to be gone"
  );
}
