/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// Copying out of an alert()/prompt() dialog. These are chrome documents, so
// they are exempt from the content analysis check in nsBaseClipboard::SetData
// and have to opt in via ContentAnalysisUtils -- the same way they already do
// for paste. What the local clipboard (keep_blocked_data_for_same_site,
// Enterprise builds only) does with such copies is covered by
// browser_clipboard_copy_local_prompt_content_analysis.js.

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
    ],
  });
});

// Copying the text the page supplied as prompt()'s default value.

async function testCopyFromPromptTextbox(allowCopy) {
  mockCA.setupForTest(allowCopy);
  setClipboardText(PREVIOUS_CLIPBOARD_TEXT);

  await withPrompt(async prompt => {
    prompt.ui.loginTextbox.focus();
    prompt.ui.loginTextbox.select();
    await EventUtils.synthesizeKey("c", { accelKey: true });

    await waitForClipboardText(
      allowCopy ? PROMPT_DEFAULT_VALUE : BLOCKED_REPLACEMENT_TEXT
    );
  });

  is(mockCA.calls.length, 1, "one call to content analysis");
  assertPromptCopyRequest(mockCA.calls[0], PROMPT_DEFAULT_VALUE);
}

add_task(async function testCopyFromPromptTextboxAllow() {
  await testCopyFromPromptTextbox(true);
});

add_task(async function testCopyFromPromptTextboxBlock() {
  await testCopyFromPromptTextbox(false);
});

// Copying the page-supplied message text out of an alert(). There is no text
// field in this case, so this is the only thing there is to copy.

async function testCopyFromAlertMessage(allowCopy) {
  mockCA.setupForTest(allowCopy);
  setClipboardText(PREVIOUS_CLIPBOARD_TEXT);

  await withAlert(async prompt => {
    let infoBody = prompt.ui.infoBody;
    is(
      infoBody.textContent,
      PROMPT_MESSAGE,
      "the dialog is showing the page's message"
    );
    let selection = infoBody.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.selectAllChildren(infoBody);

    await EventUtils.synthesizeKey(
      "c",
      { accelKey: true },
      infoBody.ownerGlobal
    );

    await waitForClipboardText(
      allowCopy ? PROMPT_MESSAGE : BLOCKED_REPLACEMENT_TEXT
    );
  });

  is(mockCA.calls.length, 1, "one call to content analysis");
  assertPromptCopyRequest(mockCA.calls[0], PROMPT_MESSAGE);
}

add_task(async function testCopyFromAlertMessageAllow() {
  await testCopyFromAlertMessage(true);
});

add_task(async function testCopyFromAlertMessageBlock() {
  await testCopyFromAlertMessage(false);
});

// The copy event is dispatched at the element holding the start of the
// selection, so selecting from the dialog's title through its message must not
// be a way to slip the message past the check.

add_task(async function testCopySpanningTitleAndMessageIsAnalyzed() {
  mockCA.setupForTest(/* shouldAllowRequest */ false);
  setClipboardText(PREVIOUS_CLIPBOARD_TEXT);

  await withAlert(async prompt => {
    let doc = prompt.ui.infoBody.ownerDocument;
    let selection = doc.getSelection();
    selection.removeAllRanges();
    let range = doc.createRange();
    range.setStartBefore(prompt.ui.infoTitle);
    range.setEndAfter(prompt.ui.infoBody);
    selection.addRange(range);
    ok(
      selection.toString().includes(PROMPT_MESSAGE),
      `selection spans the message, got "${selection.toString()}"`
    );

    await EventUtils.synthesizeKey("c", { accelKey: true }, doc.defaultView);

    await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);
  });

  is(mockCA.calls.length, 1, "one call to content analysis");
  ok(
    mockCA.calls[0].textContent.includes(PROMPT_MESSAGE),
    `the analyzed text includes the message, got "${mockCA.calls[0].textContent}"`
  );
});

// Like the content-process path, this one knows the verdict before deciding
// whether to delete, so a blocked cut leaves the text alone.

add_task(async function testBlockedCutFromPromptTextboxKeepsText() {
  mockCA.setupForTest(/* shouldAllowRequest */ false);
  setClipboardText(PREVIOUS_CLIPBOARD_TEXT);

  let result = await withPrompt(async prompt => {
    prompt.ui.loginTextbox.focus();
    prompt.ui.loginTextbox.select();
    await EventUtils.synthesizeKey("x", { accelKey: true });

    await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);
    is(
      prompt.ui.loginTextbox.value,
      PROMPT_DEFAULT_VALUE,
      "a blocked cut leaves the text field alone"
    );
  });

  is(result, PROMPT_DEFAULT_VALUE, "prompt still returns its original value");
  is(mockCA.calls.length, 1, "one call to content analysis");
  assertPromptCopyRequest(mockCA.calls[0], PROMPT_DEFAULT_VALUE);
});

add_task(async function testAllowedCutFromPromptTextboxRemovesText() {
  mockCA.setupForTest(/* shouldAllowRequest */ true);
  setClipboardText(PREVIOUS_CLIPBOARD_TEXT);

  let result = await withPrompt(async prompt => {
    prompt.ui.loginTextbox.focus();
    prompt.ui.loginTextbox.select();
    await EventUtils.synthesizeKey("x", { accelKey: true });

    await waitForClipboardText(PROMPT_DEFAULT_VALUE);
    await TestUtils.waitForCondition(
      () => prompt.ui.loginTextbox.value === "",
      "an allowed cut removes the text"
    );
  });

  is(result, "", "prompt returns the emptied value");
  is(mockCA.calls.length, 1, "one call to content analysis");
});

// Another site only ever gets the placeholder for a blocked copy out of a
// dialog.
add_task(
  async function testBlockedCopyFromPromptTextboxCrossSiteGetsPlaceholder() {
    mockCA.setupForTest(/* shouldAllowRequest */ false);
    setClipboardText(PREVIOUS_CLIPBOARD_TEXT);

    await withPrompt(
      async prompt => {
        await selectAllAndCopyFromTextbox(prompt);
        await waitForClipboardText(BLOCKED_REPLACEMENT_TEXT);
      },
      async () => {
        let otherTab = await BrowserTestUtils.openNewForegroundTab(
          gBrowser,
          PROMPT_PAGE_URL.replace("example.com", "example.org")
        );
        try {
          mockCA.setupForTest(/* shouldAllowRequest */ true);
          let pasted = await pasteIntoTarget(mockCA, otherTab.linkedBrowser);
          is(
            pasted,
            BLOCKED_REPLACEMENT_TEXT,
            "another site gets the placeholder"
          );
        } finally {
          BrowserTestUtils.removeTab(otherTab);
        }
      }
    );
  }
);

add_task(async function testCopyFromPromptWithPrefOff() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.contentanalysis.interception_point.clipboard_copy.enabled",
        false,
      ],
    ],
  });
  mockCA.setupForTest(/* shouldAllowRequest */ false);
  setClipboardText(PREVIOUS_CLIPBOARD_TEXT);

  await withPrompt(async prompt => {
    prompt.ui.loginTextbox.focus();
    prompt.ui.loginTextbox.select();
    await EventUtils.synthesizeKey("c", { accelKey: true });

    // The copy is allowed through without consulting the agent.
    await waitForClipboardText(PROMPT_DEFAULT_VALUE);
  });

  is(
    mockCA.calls.length,
    0,
    "no calls to content analysis when the interception point is off"
  );
  await SpecialPowers.popPrefEnv();
});
