/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { FeltStorage } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/FeltStorage.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const DIALOG_URL = "chrome://felt/content/consoleSetup.xhtml";

// Result slot contract with ShowEnterpriseConsoleSetup() in nsAppRunner.cpp.
const RESULT_INDEX = 0;
const RESULT_SAVED = 1;

// Opens the console setup dialog the way ShowEnterpriseConsoleSetup() does,
// minus the modal flag, which would block the test.
async function openSetupDialog() {
  const paramBlock = Cc["@mozilla.org/embedcomp/dialogparam;1"].createInstance(
    Ci.nsIDialogParamBlock
  );
  const winPromise = BrowserTestUtils.domWindowOpenedAndLoaded(
    null,
    win => win.document.documentURI === DIALOG_URL
  );
  Services.ww.openWindow(
    null,
    DIALOG_URL,
    "_blank",
    "centerscreen,chrome,titlebar,resizable",
    paramBlock
  );
  const win = await winPromise;
  await SimpleTest.promiseFocus(win);

  const doc = win.document;
  const input = doc.getElementById("console-setup-address");
  const saveBtn = doc.getElementById("console-setup-save-btn");
  const quitBtn = doc.getElementById("console-setup-quit-btn");
  const errorBar = doc.getElementById("console-setup-error");
  await Promise.all([input.updateComplete, saveBtn.updateComplete]);

  return { win, paramBlock, input, saveBtn, quitBtn, errorBar };
}

add_task(async function test_save_disabled_until_input() {
  const { win, paramBlock, saveBtn, quitBtn } = await openSetupDialog();

  ok(saveBtn.disabled, "Save is disabled while the input is empty");

  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  ok(!win.closed, "Enter does not submit while Save is disabled");

  EventUtils.sendString("h", win);
  ok(!saveBtn.disabled, "Save is enabled once the input has text");

  EventUtils.synthesizeKey("KEY_Backspace", {}, win);
  ok(saveBtn.disabled, "Save is disabled again when the input is emptied");

  const closed = BrowserTestUtils.domWindowClosed(win);
  quitBtn.click();
  await closed;
  Assert.notEqual(
    paramBlock.GetInt(RESULT_INDEX),
    RESULT_SAVED,
    "Quitting does not report a saved address"
  );
});

add_task(async function test_rejects_invalid_addresses() {
  const { win, paramBlock, saveBtn, errorBar } = await openSetupDialog();

  for (const invalid of ["not a url", "ftp://ftp.example.com/"]) {
    EventUtils.synthesizeKey("a", { accelKey: true }, win);
    EventUtils.sendString(invalid, win);
    ok(errorBar.hidden, `No error before trying to save "${invalid}"`);

    saveBtn.click();
    ok(!errorBar.hidden, `An error is shown for "${invalid}"`);
    Assert.equal(
      errorBar.getAttribute("data-l10n-id"),
      "felt-console-setup-invalid-address",
      "The error is the invalid address one"
    );
    ok(!win.closed, "The dialog stays open on an invalid address");
  }

  EventUtils.sendString("x", win);
  ok(errorBar.hidden, "Typing again clears the error");

  const closed = BrowserTestUtils.domWindowClosed(win);
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  await closed;
  Assert.notEqual(
    paramBlock.GetInt(RESULT_INDEX),
    RESULT_SAVED,
    "Escape does not report a saved address"
  );
});

add_task(async function test_valid_address_persists_and_signals_relaunch() {
  const sandbox = sinon.createSandbox();
  const init = sandbox.stub(FeltStorage, "init").resolves();
  const persist = sandbox.stub(FeltStorage, "persistConsoleAddress").resolves();

  try {
    const { win, paramBlock } = await openSetupDialog();

    EventUtils.sendString("  https://console.example.com  ", win);

    const closed = BrowserTestUtils.domWindowClosed(win);
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    await closed;

    ok(init.calledBefore(persist), "Storage is initialized before persisting");
    Assert.equal(persist.callCount, 1, "The address is persisted once");
    Assert.equal(
      persist.firstCall.args[0],
      "https://console.example.com/",
      "The persisted address is trimmed and normalized"
    );
    Assert.equal(
      paramBlock.GetInt(RESULT_INDEX),
      RESULT_SAVED,
      "The dialog reports that an address was saved"
    );
  } finally {
    sandbox.restore();
  }
});

add_task(async function test_save_failure_shows_error_and_recovers() {
  const sandbox = sinon.createSandbox();
  sandbox.stub(FeltStorage, "init").resolves();
  const persist = sandbox
    .stub(FeltStorage, "persistConsoleAddress")
    .rejects(new Error("disk full"));

  try {
    const { win, paramBlock, saveBtn, errorBar } = await openSetupDialog();

    EventUtils.sendString("https://console.example.com/", win);
    saveBtn.click();

    await TestUtils.waitForCondition(
      () => !errorBar.hidden,
      "Waiting for the error bar after a failed save"
    );
    Assert.equal(
      errorBar.getAttribute("data-l10n-id"),
      "felt-console-setup-save-failed",
      "The error is the save failure one"
    );
    ok(!saveBtn.disabled, "Save is re-enabled after a failure");
    ok(!win.closed, "The dialog stays open after a failure");
    Assert.notEqual(
      paramBlock.GetInt(RESULT_INDEX),
      RESULT_SAVED,
      "A failed save is not reported as saved"
    );

    persist.resolves();
    const closed = BrowserTestUtils.domWindowClosed(win);
    saveBtn.click();
    await closed;
    Assert.equal(
      paramBlock.GetInt(RESULT_INDEX),
      RESULT_SAVED,
      "Retrying after a failure saves and closes"
    );
  } finally {
    sandbox.restore();
  }
});
