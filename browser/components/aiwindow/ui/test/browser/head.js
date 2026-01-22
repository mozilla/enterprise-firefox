/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  Chat: "moz-src:///browser/components/aiwindow/models/Chat.sys.mjs",
  openAIEngine: "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs",
  sinon: "resource://testing-common/Sinon.sys.mjs",
});

const AIWINDOW_URL = "chrome://browser/content/aiwindow/aiWindow.html";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.aiwindow.enabled", true],
      ["browser.aiwindow.firstrun.hasCompleted", true],
    ],
  });
});

/**
 * Opens a new AI Window
 *
 * @returns {Promise<Window>}
 */
async function openAIWindow() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ aiWindow: true });
  await BrowserTestUtils.waitForMutationCondition(
    win.document.documentElement,
    { attributes: true },
    () => win.document.documentElement.hasAttribute("ai-window")
  );
  return win;
}
