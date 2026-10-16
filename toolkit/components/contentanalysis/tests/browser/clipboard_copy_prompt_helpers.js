/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// Helpers shared by the tests that copy out of alert()/prompt() dialogs.
// Load after clipboard_copy_helpers.js.

"use strict";

const { PromptTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromptTestUtils.sys.mjs"
);

// Using an external page so the test can check that the URL matches in the
// nsIContentAnalysisRequest.
const PROMPT_PAGE_URL =
  "https://example.com/browser/toolkit/components/contentanalysis/tests/browser/clipboard_paste_prompt.html";
const PROMPT_MESSAGE = "Some message from the page";
const PROMPT_DEFAULT_VALUE = "Some default value";

function assertPromptCopyRequest(request, expectedText) {
  is(request.url.spec, PROMPT_PAGE_URL, "request has correct URL");
  is(
    request.analysisType,
    Ci.nsIContentAnalysisRequest.eDataCopied,
    "request has correct analysisType"
  );
  is(
    request.reason,
    Ci.nsIContentAnalysisRequest.eClipboardCopy,
    "request has correct reason"
  );
  is(
    request.operationTypeForDisplay,
    Ci.nsIContentAnalysisRequest.eCopyClipboard,
    "request has correct operationTypeForDisplay"
  );
  is(request.textContent, expectedText, "request textContent should match");
  ok(request.userActionId.length, "request userActionId should not be empty");
  ok(!!request.requestToken.length, "request requestToken should not be empty");
}

// Opens a dialog on PROMPT_PAGE_URL, async runs function aContentFn in its content process
// (which must generate a dialog with alert()/prompt()/etc), passes the content
// process' dialog to aTestFn for testing, and returns the result of aContentFn.
// If aAfterDialogFn is given, it runs with the tab's browser once the dialog
// has been dismissed and before the tab is closed.
async function withDialog(aContentFn, aTestFn, aAfterDialogFn) {
  let tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    PROMPT_PAGE_URL
  );
  let browser = tab.linkedBrowser;
  try {
    let dialogPromise = SpecialPowers.spawn(
      browser,
      [PROMPT_MESSAGE, PROMPT_DEFAULT_VALUE],
      aContentFn
    );

    let prompt = await PromptTestUtils.waitForPrompt(browser, {
      modalType: Services.prompt.MODAL_TYPE_CONTENT,
    });

    try {
      await aTestFn(prompt);
    } finally {
      await PromptTestUtils.handlePrompt(prompt);
    }
    let result = await dialogPromise;
    if (aAfterDialogFn) {
      await aAfterDialogFn(browser);
    }
    return result;
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
}

function withPrompt(aCallback, aAfterDialogFn) {
  return withDialog(
    async (message, defaultValue) => content.prompt(message, defaultValue),
    aCallback,
    aAfterDialogFn
  );
}

// alert() is the case with no text field at all, so the only thing to copy is
// the page-supplied message.
function withAlert(aCallback, aAfterDialogFn) {
  return withDialog(
    async message => content.alert(message),
    aCallback,
    aAfterDialogFn
  );
}

function selectAllAndCopyFromTextbox(prompt) {
  prompt.ui.loginTextbox.focus();
  prompt.ui.loginTextbox.select();
  return EventUtils.synthesizeKey("c", { accelKey: true });
}
