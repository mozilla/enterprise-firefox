/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Services.scriptloader.loadSubScript(
  "chrome://mochitests/content/browser/browser/components/preferences/tests/head.js",
  this
);
Services.scriptloader.loadSubScript(
  "chrome://mochitests/content/browser/browser/components/preferences/tests/aiFeatures/head_smart_window.js",
  this
);

async function withPrefsPane(pane, testFn) {
  await openPreferencesViaOpenPreferencesAPI(pane, { leaveOpen: true });
  let doc = gBrowser.selectedBrowser.contentDocument;
  try {
    await testFn(doc);
  } finally {
    BrowserTestUtils.removeTab(gBrowser.selectedTab);
  }
}
