/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// Copies out of alert()/prompt() dialogs with the local clipboard
// (keep_blocked_data_for_same_site) on are kept for the page that opened
// the dialog exactly like copies from the page itself.

"use strict";

/* import-globals-from clipboard_copy_helpers.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "clipboard_copy_helpers.js",
  this
);
/* import-globals-from clipboard_copy_prompt_helpers.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "clipboard_copy_prompt_helpers.js",
  this
);

let mockCA = makeMockContentAnalysis();

add_setup(async function test_setup() {
  mockCA = await mockContentAnalysisService(mockCA);
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.contentanalysis.interception_point.clipboard_copy.enabled",
        true,
      ],
      [KEEP_LOCAL_COPY_PREF, true],
    ],
  });
});

// A blocked copy out of a dialog is kept for same-site paste, exactly like a
// blocked copy from the page itself: the opening page gets the text back
// (after the paste check), other sites and chrome get the placeholder.
add_task(async function testBlockedCopyFromPromptTextboxPastesSameSite() {
  mockCA.setupForTest(/* shouldAllowRequest */ false);
  setClipboardText(PREVIOUS_CLIPBOARD_TEXT);

  await withPrompt(
    async prompt => {
      await selectAllAndCopyFromTextbox(prompt);
      await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);
      is(mockCA.calls.length, 1, "one call to content analysis for the copy");
      assertPromptCopyRequest(mockCA.calls[0], PROMPT_DEFAULT_VALUE);
    },
    async browser => {
      mockCA.setupForTest(/* shouldAllowRequest */ true);
      let pasted = await pasteIntoTarget(mockCA, browser);
      is(
        pasted,
        PROMPT_DEFAULT_VALUE,
        "the opening page gets the blocked copy back"
      );
      is(mockCA.calls.length, 1, "the paste was analyzed");
      is(
        mockCA.calls[0].reason,
        Ci.nsIContentAnalysisRequest.eClipboardPaste,
        "the paste request has the paste reason"
      );
      is(
        mockCA.calls[0].textContent,
        PROMPT_DEFAULT_VALUE,
        "the paste request carries the original text"
      );
      is(
        getClipboardText(),
        BLOCKED_REPLACEMENT_TEXT,
        "chrome still only sees the placeholder"
      );
    }
  );
});

add_task(async function testBlockedCopyFromAlertMessagePastesSameSite() {
  mockCA.setupForTest(/* shouldAllowRequest */ false);
  setClipboardText(PREVIOUS_CLIPBOARD_TEXT);

  await withAlert(
    async prompt => {
      let infoBody = prompt.ui.infoBody;
      let selection = infoBody.ownerDocument.getSelection();
      selection.removeAllRanges();
      selection.selectAllChildren(infoBody);
      await EventUtils.synthesizeKey(
        "c",
        { accelKey: true },
        infoBody.ownerGlobal
      );
      await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);
    },
    async browser => {
      mockCA.setupForTest(/* shouldAllowRequest */ true);
      let pasted = await pasteIntoTarget(mockCA, browser);
      is(pasted, PROMPT_MESSAGE, "the opening page gets the message back");
    }
  );
});

// A blocked cut keeps the text in the field, and that text is still available
// to a same-site paste.
add_task(async function testBlockedCutFromPromptTextboxPastesSameSite() {
  mockCA.setupForTest(/* shouldAllowRequest */ false);
  setClipboardText(PREVIOUS_CLIPBOARD_TEXT);

  await withPrompt(
    async prompt => {
      prompt.ui.loginTextbox.focus();
      prompt.ui.loginTextbox.select();
      await EventUtils.synthesizeKey("x", { accelKey: true });
      await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);
      is(
        prompt.ui.loginTextbox.value,
        PROMPT_DEFAULT_VALUE,
        "a blocked cut leaves the text field alone"
      );
    },
    async browser => {
      mockCA.setupForTest(/* shouldAllowRequest */ true);
      let pasted = await pasteIntoTarget(mockCA, browser);
      is(pasted, PROMPT_DEFAULT_VALUE, "the cut text can be pasted same-site");
    }
  );
});

// With the local clipboard on, a warned copy out of the prompt does not hold
// the dialog: the warn placeholder goes on the system clipboard, the opening
// page can paste the text meanwhile, and allowing the warning later commits
// it.
add_task(async function testWarnedCopyFromPromptTextboxKeptForOpeningPage() {
  mockCA.setupForTest("warn");
  setClipboardText(PREVIOUS_CLIPBOARD_TEXT);

  await withPrompt(
    async prompt => {
      await selectAllAndCopyFromTextbox(prompt);
      await waitForClipboardText(WARN_REPLACEMENT_TEXT);
      is(mockCA.calls.length, 1, "one call to content analysis for the copy");
      assertPromptCopyRequest(mockCA.calls[0], PROMPT_DEFAULT_VALUE);
    },
    async browser => {
      let info = getLocalCopyInfo(mockCA);
      is(
        info?.state,
        Ci.nsIContentAnalysisLocalCopyInfo.WARN,
        "the copy awaits the user's answer"
      );
      let pasted = await pasteIntoTarget(mockCA, browser);
      is(pasted, PROMPT_DEFAULT_VALUE, "the opening page gets the warned copy");

      let resolved = promiseWarnResolved("user");
      mockCA.respondToWarnDialog(info.warnRequestToken, true);
      await resolved;
      await waitForClipboardText(PROMPT_DEFAULT_VALUE);
      ok(!getLocalCopyInfo(mockCA), "the committed copy left the local slot");
    }
  );
});
