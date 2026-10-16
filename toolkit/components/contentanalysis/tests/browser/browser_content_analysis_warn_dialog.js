/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

let mockCA = makeMockContentAnalysis();

add_setup(async function test_setup() {
  mockCA = await mockContentAnalysisService(mockCA);
});

const testPage =
  "<body style='margin: 0'><input id='input' type='text'></body>";

const CLIPBOARD_TEXT_STRING = "Just some text";

const RULE_MESSAGE =
  "Pasting work data into AI services may violate company policy.";

function setClipboardData(clipboardString) {
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

/**
 * Pastes with a warn verdict pending, hands the open warn dialog's body to
 * aCheckBody, then dismisses it with the given button.
 *
 * @param {object} options
 * @param {string} options.ruleMessage
 * @param {boolean} options.allowAfterWarn
 * @param {Function} options.checkBody
 */
async function pasteAndCheckWarnDialog({
  ruleMessage,
  allowAfterWarn,
  checkBody,
}) {
  mockCA.setupForTest(
    "warn",
    /* waitForEvent */ false,
    /* showDialogs */ true,
    ruleMessage
  );

  let tab = BrowserTestUtils.addTab(gBrowser);
  let browser = gBrowser.getBrowserForTab(tab);
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.loadURIString({
    browser: tab.linkedBrowser,
    uriString: "data:text/html," + escape(testPage),
  });
  await SimpleTest.promiseFocus(browser);

  setClipboardData(CLIPBOARD_TEXT_STRING);

  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("input").value = "";
    content.document.getElementById("input").focus();
  });

  let warnDialogPromise = BrowserTestUtils.promiseAlertDialogOpen();
  // Deliberately not awaited here: a warn verdict doesn't resolve the paste
  // until respondToWarnDialog() is called, and synthesizeKey() doesn't
  // resolve until the paste it triggered has been handled. Awaiting it
  // before answering the dialog deadlocks the test.
  let keyPromise = BrowserTestUtils.synthesizeKey(
    "v",
    { accelKey: true },
    browser
  );
  let win = await warnDialogPromise;

  checkBody(win.document.getElementById("infoBody").textContent);

  win.document
    .querySelector("dialog")
    .getButton(allowAfterWarn ? "accept" : "cancel")
    .click();
  await keyPromise;

  is(
    await SpecialPowers.spawn(browser, [], () => {
      return content.document.getElementById("input").value;
    }),
    allowAfterWarn ? CLIPBOARD_TEXT_STRING : "",
    "checking text field contents"
  );

  BrowserTestUtils.removeTab(tab);
}

// A parent-process read, like any other application would do.
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

// With the local clipboard off, a warned copy holds the page and shows the
// warn dialog; the copy lands on the clipboard once the user allows it.
add_task(async function testWarnDialogForCopyWithLocalClipboardOff() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.contentanalysis.interception_point.clipboard_copy.enabled",
        true,
      ],
      [
        "browser.contentanalysis.interception_point.clipboard_copy.keep_blocked_data_for_same_site",
        false,
      ],
    ],
  });
  mockCA.setupForTest("warn", /* waitForEvent */ false, /* showDialogs */ true);

  let tab = BrowserTestUtils.addTab(gBrowser);
  let browser = gBrowser.getBrowserForTab(tab);
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.loadURIString({
    browser: tab.linkedBrowser,
    uriString: "data:text/html," + escape(testPage),
  });
  await SimpleTest.promiseFocus(browser);

  setClipboardData("");
  await SpecialPowers.spawn(browser, [CLIPBOARD_TEXT_STRING], text => {
    let input = content.document.getElementById("input");
    input.value = text;
    input.focus();
    input.select();
  });

  let warnDialogPromise = BrowserTestUtils.promiseAlertDialogOpen();
  let keyPromise = BrowserTestUtils.synthesizeKey(
    "c",
    { accelKey: true },
    browser
  );
  let win = await warnDialogPromise;
  ok(
    win.document
      .getElementById("infoBody")
      .textContent.includes("flagged this content as unsafe"),
    "the warn dialog is shown for the copy"
  );
  win.document.querySelector("dialog").getButton("accept").click();
  await keyPromise;

  await TestUtils.waitForCondition(
    () => getClipboardText() === CLIPBOARD_TEXT_STRING,
    "waiting for the allowed copy to reach the clipboard"
  );

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function testWarnDialogShowsRuleMessage() {
  await pasteAndCheckWarnDialog({
    ruleMessage: RULE_MESSAGE,
    allowAfterWarn: true,
    checkBody: body => {
      ok(
        body.includes("flagged this content as unsafe"),
        "warn dialog keeps its built-in description"
      );
      ok(
        body.includes("Message from your administrator"),
        "the admin message is labeled as such"
      );
      ok(
        body.includes(RULE_MESSAGE),
        "warn dialog shows the rule's admin message"
      );
    },
  });
});

add_task(async function testWarnDialogWithoutRuleMessage() {
  await pasteAndCheckWarnDialog({
    ruleMessage: "",
    allowAfterWarn: false,
    checkBody: body => {
      ok(
        body.includes("flagged this content as unsafe"),
        "warn dialog shows its built-in description"
      );
      ok(
        !body.includes("Message from your administrator"),
        "no admin message section when the rule supplied none"
      );
    },
  });
});
