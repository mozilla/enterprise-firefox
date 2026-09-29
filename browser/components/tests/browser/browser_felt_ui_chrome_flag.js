/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const CHROME_URL = "chrome://browser/content/browser.xhtml";

function withFakeFelt(isFeltUI, fn) {
  const realFelt = Services.felt;
  Object.defineProperty(Services, "felt", {
    configurable: true,
    value: {
      isFeltUI: () => isFeltUI,
      isFeltBrowser: () => false,
    },
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(Services, "felt", {
      configurable: true,
      value: realFelt,
    });
  }
}

function handleChromeFlag() {
  const cmdLine = Cu.createCommandLine(
    ["-chrome", CHROME_URL],
    Services.dirsvc.get("CurWorkD", Ci.nsIFile),
    Ci.nsICommandLine.STATE_REMOTE_EXPLICIT
  );
  Cc["@mozilla.org/browser/clh;1"]
    .getService(Ci.nsICommandLineHandler)
    .handle(cmdLine);
  return cmdLine;
}

function windowCount() {
  return [...Services.wm.getEnumerator(null)].length;
}

add_task(async function test_chrome_flag_ignored_in_felt_ui() {
  const before = windowCount();
  const cmdLine = withFakeFelt(true, handleChromeFlag);
  Assert.ok(cmdLine.preventDefault, "The --chrome flag is consumed");
  Assert.equal(windowCount(), before, "No window is opened in Felt UI");
});

add_task(async function test_chrome_flag_opens_window_outside_felt_ui() {
  const newWinPromise = BrowserTestUtils.domWindowOpenedAndLoaded();
  withFakeFelt(false, handleChromeFlag);
  const win = await newWinPromise;
  Assert.equal(
    win.document.documentURI,
    CHROME_URL,
    "The --chrome window opens outside Felt UI"
  );
  await BrowserTestUtils.closeWindow(win);
});
