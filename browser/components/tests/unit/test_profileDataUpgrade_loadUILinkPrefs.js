/* Any copyright is dedicated to the Public Domain.
http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ProfileDataUpgrader } = ChromeUtils.importESModule(
  "moz-src:///browser/components/ProfileDataUpgrader.sys.mjs"
);

const RENAMED_PREFS = [
  ["browser.tabs.loadBookmarksInTabs", "browser.tabs.loadUILinkInTab"],
  [
    "browser.tabs.loadBookmarksInBackground",
    "browser.tabs.loadUILinkInBackground",
  ],
];

function clearPrefs() {
  for (let [oldPref, newPref] of RENAMED_PREFS) {
    Services.prefs.clearUserPref(oldPref);
    Services.prefs.clearUserPref(newPref);
  }
  Services.prefs.clearUserPref("browser.migration.version");
}

add_setup(() => {
  registerCleanupFunction(clearPrefs);
});

add_task(function test_user_values_are_migrated() {
  for (let [oldPref] of RENAMED_PREFS) {
    Services.prefs.setBoolPref(oldPref, true);
  }

  ProfileDataUpgrader.upgrade(184, 185);

  for (let [oldPref, newPref] of RENAMED_PREFS) {
    Assert.ok(
      Services.prefs.getBoolPref(newPref),
      `${newPref} should inherit the user value of ${oldPref}`
    );
    Assert.ok(
      !Services.prefs.prefHasUserValue(oldPref),
      `${oldPref} should be cleared`
    );
  }

  clearPrefs();
});

add_task(function test_default_values_are_untouched() {
  ProfileDataUpgrader.upgrade(184, 185);

  for (let [, newPref] of RENAMED_PREFS) {
    Assert.ok(
      !Services.prefs.prefHasUserValue(newPref),
      `${newPref} should keep its default value`
    );
  }
});
