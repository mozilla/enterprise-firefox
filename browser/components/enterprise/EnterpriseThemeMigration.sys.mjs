/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  BuiltInThemeConfig: "resource:///modules/BuiltInThemeConfig.sys.mjs",
});

const ACTIVE_THEME_PREF = "extensions.activeThemeID";
const AUTO_THEME_ID = "firefox-enterprise-auto@mozilla.org";

// Enterprise themes that were replaced by the single auto theme.
const REMOVED_THEME_IDS = [
  "firefox-enterprise-light@mozilla.org",
  "firefox-enterprise-dark@mozilla.org",
];

export const EnterpriseThemeMigration = {
  /**
   * Move profiles still on a removed enterprise light/dark theme to the auto
   * theme. The old id is cached before this runs, so we install and explicitly
   * enable the auto theme rather than only rewriting the pref.
   */
  async migrate() {
    if (!Services.prefs.prefHasUserValue(ACTIVE_THEME_PREF)) {
      return;
    }
    if (
      !REMOVED_THEME_IDS.includes(
        Services.prefs.getStringPref(ACTIVE_THEME_PREF, "")
      )
    ) {
      return;
    }

    Services.prefs.setStringPref(ACTIVE_THEME_PREF, AUTO_THEME_ID);

    let themeInfo = lazy.BuiltInThemeConfig.get(AUTO_THEME_ID);
    await lazy.AddonManager.maybeInstallBuiltinAddon(
      AUTO_THEME_ID,
      themeInfo.version,
      themeInfo.path
    );
    let addon = await lazy.AddonManager.getAddonByID(AUTO_THEME_ID);
    await addon?.enable();
  },
};
