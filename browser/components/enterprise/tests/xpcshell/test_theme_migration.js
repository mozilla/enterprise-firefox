/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AddonManager } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs"
);
const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
const { BuiltInThemeConfig } = ChromeUtils.importESModule(
  "resource:///modules/BuiltInThemeConfig.sys.mjs"
);
const { EnterpriseThemeMigration } = ChromeUtils.importESModule(
  "resource:///modules/enterprise/EnterpriseThemeMigration.sys.mjs"
);

const ACTIVE_THEME_PREF = "extensions.activeThemeID";
const AUTO_THEME_ID = "firefox-enterprise-auto@mozilla.org";
const LIGHT_THEME_ID = "firefox-enterprise-light@mozilla.org";

const AUTO_THEME_MANIFEST = {
  manifest_version: 2,
  name: "Firefox Enterprise Auto",
  version: "1.0.0",
  browser_specific_settings: { gecko: { id: AUTO_THEME_ID } },
  theme: { colors: { toolbar: "#ffffff" } },
  dark_theme: { colors: { toolbar: "#1f2026" } },
};

AddonTestUtils.init(this);
AddonTestUtils.createAppInfo(
  "xpcshell@tests.mozilla.org",
  "XPCShell",
  "1",
  "1"
);

add_setup(async function () {
  // Enable the built-in (application) scope so maybeInstallBuiltinAddon installs.
  Services.prefs.setIntPref(
    "extensions.enabledScopes",
    AddonManager.SCOPE_PROFILE | AddonManager.SCOPE_APPLICATION
  );

  // Simulate a profile upgrading from a build that had the (now removed) light
  // theme selected, so XPIProvider caches lastSelectedTheme = light when the
  // default theme is installed during startup.
  Services.prefs.setStringPref(ACTIVE_THEME_PREF, LIGHT_THEME_ID);
  await AddonTestUtils.promiseStartupManager();

  // Make the auto theme installable as a built-in from a temp resource, and
  // point the (test) BuiltInThemeConfig entry at it.
  let xpi = await AddonTestUtils.createTempWebExtensionFile({
    manifest: AUTO_THEME_MANIFEST,
  });
  let resProto = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  resProto.setSubstitution(
    "enterprise-auto-test",
    Services.io.newURI(`jar:file:${xpi.path}!/`)
  );
  BuiltInThemeConfig.set(AUTO_THEME_ID, {
    version: "1.0.0",
    path: "resource://enterprise-auto-test/",
  });

  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("extensions.enabledScopes");
    Services.prefs.clearUserPref(ACTIVE_THEME_PREF);
    BuiltInThemeConfig.delete(AUTO_THEME_ID);
    resProto.setSubstitution("enterprise-auto-test", null);
  });
});

add_task(async function test_migrates_and_activates_auto() {
  Assert.equal(
    Services.prefs.getStringPref(ACTIVE_THEME_PREF),
    LIGHT_THEME_ID,
    "starts with the removed light theme selected"
  );

  await EnterpriseThemeMigration.migrate();

  Assert.equal(
    Services.prefs.getStringPref(ACTIVE_THEME_PREF),
    AUTO_THEME_ID,
    "activeThemeID is remapped to the auto theme"
  );

  let addon = await AddonManager.getAddonByID(AUTO_THEME_ID);
  Assert.ok(addon, "the auto theme is installed");
  // The key regression: because lastSelectedTheme was cached as the removed id,
  // the auto theme installs disabled and must be explicitly enabled.
  Assert.ok(addon.isActive, "the auto theme is active, not left disabled");
});

add_task(async function test_leaves_unrelated_theme_untouched() {
  const OTHER = "firefox-compact-dark@mozilla.org";
  Services.prefs.setStringPref(ACTIVE_THEME_PREF, OTHER);

  await EnterpriseThemeMigration.migrate();

  Assert.equal(
    Services.prefs.getStringPref(ACTIVE_THEME_PREF),
    OTHER,
    "an unrelated selected theme is left untouched"
  );
});

add_task(async function test_no_user_selection() {
  Services.prefs.clearUserPref(ACTIVE_THEME_PREF);

  await EnterpriseThemeMigration.migrate();

  Assert.ok(
    !Services.prefs.prefHasUserValue(ACTIVE_THEME_PREF),
    "no theme is forced when the user never selected one"
  );
});
