/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
// This is an xpcshell test, but a sibling browser.toml makes eslint apply the
// browser-test env, where TestUtils is a predefined global. It isn't one in
// xpcshell (there's no head.js here to import it either), so the import is
// required.
// eslint-disable-next-line mozilla/no-redeclare-with-import-autofix
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const {
  CustomIconManager,
  ICON_CATALOG,
  resolvePreview,
  resolveResourceId,
  OS_LIGHT,
  OS_DARK,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/shell/CustomIconManager.sys.mjs"
);

const PREF_ICON_ID = "browser.shell.customIcon.id";
const TEST_AUMID = "Test.Firefox.AUMID";
const TEST_SHORTCUTS = ["C:\\fake\\Desktop\\Nightly.lnk"];
const RETRO_RESOURCE_ID = ICON_CATALOG.retro2004.iconResourceId;

// CustomIconManager.apply() refuses to run on MSIX (packaged) builds, so on the
// MSIX CI job every task except the MSIX-specific one (which fakes the
// condition itself and runs everywhere) is skipped.
const ON_MSIX = Services.sysinfo.getProperty("hasWinPackageId");

// add_task() mutates the options object it is handed (tagging it isTask), so
// each call needs its own fresh object rather than a shared one.
function skipOnMsix() {
  return { skip_if: () => ON_MSIX };
}

function exePath() {
  return Services.dirsvc.get("XREExeF", Ci.nsIFile).path;
}

let shellServiceMock = {
  QueryInterface: ChromeUtils.generateQI([Ci.nsIWindowsShellService]),
  enumerateInstallShortcuts: sinon.stub(),
  setShortcutsIcon: sinon.stub(),
};

let winTaskbarMock = {
  QueryInterface: ChromeUtils.generateQI([Ci.nsIWinTaskbar]),
  setAllWindowIcons: sinon.stub(),
  get defaultGroupId() {
    return TEST_AUMID;
  },
};

// Reset stub history + default behaviour and clear the pref before each task.
function resetMocks() {
  shellServiceMock.enumerateInstallShortcuts.reset();
  shellServiceMock.enumerateInstallShortcuts.resolves(TEST_SHORTCUTS.slice());
  shellServiceMock.setShortcutsIcon.reset();
  shellServiceMock.setShortcutsIcon.resolves();
  winTaskbarMock.setAllWindowIcons.reset();
  Services.prefs.clearUserPref(PREF_ICON_ID);
}

add_setup(function () {
  let shellCid = MockRegistrar.register(
    "@mozilla.org/browser/shell-service;1",
    shellServiceMock
  );
  let taskbarCid = MockRegistrar.register(
    "@mozilla.org/windows-taskbar;1",
    winTaskbarMock
  );

  registerCleanupFunction(() => {
    MockRegistrar.unregister(taskbarCid);
    MockRegistrar.unregister(shellCid);
    Services.prefs.clearUserPref(PREF_ICON_ID);
  });
});

/**
 * This test verifies that apply() enumerates shortcuts by the default AUMID,
 * writes the catalog resource ID (positive, un-negated) and the executable
 * path to the matching shortcuts, sets the runtime window icon, and records
 * the pref.
 */
add_task(
  skipOnMsix(),
  async function test_apply_updates_shortcuts_pref_and_runtime() {
    resetMocks();

    await CustomIconManager.apply("retro2004");

    Assert.ok(
      shellServiceMock.enumerateInstallShortcuts.calledOnceWithExactly(
        TEST_AUMID
      ),
      "enumerateInstallShortcuts called once with the default AUMID"
    );

    Assert.ok(
      shellServiceMock.setShortcutsIcon.calledOnce,
      "setShortcutsIcon called once"
    );
    let [shortcuts, iconPath, resourceId] =
      shellServiceMock.setShortcutsIcon.getCall(0).args;
    Assert.deepEqual(
      shortcuts,
      TEST_SHORTCUTS,
      "passed the enumerated shortcuts through"
    );
    Assert.equal(iconPath, exePath(), "icon source is the running executable");
    Assert.equal(
      resourceId,
      RETRO_RESOURCE_ID,
      "passed the catalog resource ID as-is (negation happens in C++, not JS)"
    );

    Assert.ok(
      winTaskbarMock.setAllWindowIcons.calledOnceWithExactly(RETRO_RESOURCE_ID),
      "runtime window icon set to the retro resource ID"
    );
    Assert.equal(
      Services.prefs.getStringPref(PREF_ICON_ID, ""),
      "retro2004",
      "pref records the applied id"
    );
  }
);

/**
 * This test verifies that apply() rejects when given an id absent from the
 * catalog, without touching any shortcut or runtime state or the pref.
 */
add_task(skipOnMsix(), async function test_apply_unknown_id_throws() {
  resetMocks();

  await Assert.rejects(
    CustomIconManager.apply("does-not-exist"),
    /Unknown icon id/,
    "apply rejects for an unknown catalog id"
  );

  Assert.ok(
    shellServiceMock.setShortcutsIcon.notCalled,
    "no shortcut work attempted for an unknown id"
  );
  Assert.ok(
    winTaskbarMock.setAllWindowIcons.notCalled,
    "no runtime work attempted for an unknown id"
  );
  Assert.equal(
    Services.prefs.getStringPref(PREF_ICON_ID, ""),
    "",
    "pref left untouched"
  );
});

/**
 * This test verifies that apply() throws on MSIX (packaged) builds, where the
 * feature is unsupported, without touching shortcuts, the runtime icon, or the
 * pref.
 */
add_task(async function test_apply_throws_on_msix() {
  resetMocks();

  // Fake an MSIX build by flipping the sysinfo property the manager checks.
  // nsSystemInfo is a writable property bag, so set it directly and restore it.
  let bag = Services.sysinfo.QueryInterface(Ci.nsIWritablePropertyBag2);
  let original = bag.getProperty("hasWinPackageId");
  bag.setPropertyAsBool("hasWinPackageId", true);

  try {
    await Assert.rejects(
      CustomIconManager.apply("retro2004"),
      /MSIX/,
      "apply rejects on an MSIX build"
    );

    Assert.ok(
      shellServiceMock.setShortcutsIcon.notCalled,
      "no shortcut work attempted on MSIX"
    );
    Assert.ok(
      winTaskbarMock.setAllWindowIcons.notCalled,
      "no runtime work attempted on MSIX"
    );
    Assert.equal(
      Services.prefs.getStringPref(PREF_ICON_ID, ""),
      "",
      "pref left untouched on MSIX"
    );
  } finally {
    bag.setPropertyAsBool("hasWinPackageId", original);
  }
});

/**
 * This test verifies that revert() resets matching shortcuts to the
 * executable's default icon (resource ID 0), clears the runtime override, and
 * clears the pref.
 */
add_task(
  skipOnMsix(),
  async function test_revert_resets_shortcuts_pref_and_runtime() {
    resetMocks();
    Services.prefs.setStringPref(PREF_ICON_ID, "retro2004");

    await CustomIconManager.revert();

    Assert.ok(
      shellServiceMock.setShortcutsIcon.calledOnce,
      "setShortcutsIcon called once"
    );
    let [, iconPath, resourceId] =
      shellServiceMock.setShortcutsIcon.getCall(0).args;
    Assert.equal(iconPath, exePath(), "reverts using the executable path");
    Assert.equal(
      resourceId,
      0,
      "resource ID 0 selects the executable's default icon"
    );

    Assert.ok(
      winTaskbarMock.setAllWindowIcons.calledOnceWithExactly(0),
      "runtime window icon cleared (0)"
    );
    Assert.ok(!Services.prefs.prefHasUserValue(PREF_ICON_ID), "pref cleared");
  }
);

/**
 * This test verifies that when enumeration matches no shortcuts, apply() skips
 * setShortcutsIcon but still applies the runtime icon and records the pref, so
 * the running window updates even though no shortcut could be changed.
 */
add_task(skipOnMsix(), async function test_apply_no_matching_shortcuts() {
  resetMocks();
  shellServiceMock.enumerateInstallShortcuts.resolves([]);

  // Must not throw even though nothing matched.
  await CustomIconManager.apply("retro2004");

  Assert.ok(
    shellServiceMock.setShortcutsIcon.notCalled,
    "setShortcutsIcon not called when enumeration matched nothing"
  );
  Assert.ok(
    winTaskbarMock.setAllWindowIcons.calledOnceWithExactly(RETRO_RESOURCE_ID),
    "runtime icon still applied even though no shortcut changed"
  );
  Assert.equal(
    Services.prefs.getStringPref(PREF_ICON_ID, ""),
    "retro2004",
    "pref still recorded"
  );
});

/**
 * This test verifies that when setShortcutsIcon rejects, apply() logs and
 * swallows the failure rather than throwing, and still applies the runtime
 * icon and pref.
 */
add_task(
  skipOnMsix(),
  async function test_apply_shortcut_write_failure_is_swallowed() {
    resetMocks();
    shellServiceMock.setShortcutsIcon.rejects(
      Components.Exception(
        "mock setShortcutsIcon failure",
        Cr.NS_ERROR_NOT_AVAILABLE
      )
    );

    // A shortcut-write failure is logged, not thrown.
    await CustomIconManager.apply("retro2004");

    Assert.ok(
      shellServiceMock.setShortcutsIcon.calledOnce,
      "setShortcutsIcon was attempted"
    );
    Assert.ok(
      winTaskbarMock.setAllWindowIcons.calledOnceWithExactly(RETRO_RESOURCE_ID),
      "runtime icon still applied despite the shortcut-write failure"
    );
    Assert.equal(
      Services.prefs.getStringPref(PREF_ICON_ID, ""),
      "retro2004",
      "pref still recorded"
    );
  }
);

/**
 * This test verifies that ensureAppliedOrRevert() with a pref naming a known
 * catalog id re-applies the runtime icon only, without rewriting shortcuts,
 * and keeps the pref.
 */
add_task(
  skipOnMsix(),
  async function test_ensureAppliedOrRevert_applies_known_id() {
    resetMocks();
    Services.prefs.setStringPref(PREF_ICON_ID, "retro2004");

    await CustomIconManager.ensureAppliedOrRevert();

    Assert.ok(
      winTaskbarMock.setAllWindowIcons.calledOnceWithExactly(RETRO_RESOURCE_ID),
      "runtime icon applied for a known id"
    );
    Assert.ok(
      shellServiceMock.setShortcutsIcon.notCalled,
      "ensureAppliedOrRevert does not rewrite shortcuts for a known id"
    );
    Assert.equal(
      Services.prefs.getStringPref(PREF_ICON_ID, ""),
      "retro2004",
      "pref retained"
    );
  }
);

/**
 * This test verifies that ensureAppliedOrRevert() with a pref naming an id
 * absent from the catalog (e.g. a newer build's icon, or one since retired)
 * reverts the shortcuts and runtime icon to default and clears the pref.
 */
add_task(
  skipOnMsix(),
  async function test_ensureAppliedOrRevert_reverts_unknown_id() {
    resetMocks();
    Services.prefs.setStringPref(PREF_ICON_ID, "icon-from-a-newer-build");

    await CustomIconManager.ensureAppliedOrRevert();

    // Unknown id -> revert: shortcuts reset to default, runtime cleared, pref
    // cleared.
    Assert.ok(
      shellServiceMock.setShortcutsIcon.calledOnce,
      "revert rewrote shortcuts"
    );
    Assert.equal(
      shellServiceMock.setShortcutsIcon.getCall(0).args[2],
      0,
      "shortcuts reset to the default icon"
    );
    Assert.ok(
      winTaskbarMock.setAllWindowIcons.calledOnceWithExactly(0),
      "runtime icon cleared"
    );
    Assert.ok(!Services.prefs.prefHasUserValue(PREF_ICON_ID), "pref cleared");
  }
);

/**
 * This test verifies that ensureAppliedOrRevert() does nothing when no custom
 * icon pref is set.
 */
add_task(
  skipOnMsix(),
  async function test_ensureAppliedOrRevert_noop_without_pref() {
    resetMocks();

    await CustomIconManager.ensureAppliedOrRevert();

    Assert.ok(
      shellServiceMock.setShortcutsIcon.notCalled,
      "no shortcut work when no custom icon is recorded"
    );
    Assert.ok(
      winTaskbarMock.setAllWindowIcons.notCalled,
      "no runtime work when no custom icon is recorded"
    );
  }
);

/**
 * This test verifies the theme-aware catalog shape: a theme-aware icon exposes
 * distinct dark/light variants and resolveResourceId()/resolvePreview() pick the
 * scheme-specific asset, while a flat icon ignores the scheme.
 */
add_task(async function test_theme_aware_catalog() {
  let minimal = ICON_CATALOG.minimal;
  Assert.ok(minimal.variants, "minimal is theme-aware");
  Assert.notEqual(
    minimal.variants.dark.iconResourceId,
    minimal.variants.light.iconResourceId,
    "dark and light variants use distinct resource IDs"
  );
  Assert.notEqual(
    resolvePreview(minimal, "dark"),
    resolvePreview(minimal, "light"),
    "resolvePreview returns the scheme-specific preview for a theme-aware icon"
  );
  Assert.equal(
    resolveResourceId(minimal, "dark"),
    minimal.variants.dark.iconResourceId,
    "resolveResourceId picks the dark variant's id under a dark scheme"
  );
  Assert.equal(
    resolveResourceId(minimal, "light"),
    minimal.variants.light.iconResourceId,
    "resolveResourceId picks the light variant's id under a light scheme"
  );

  let retro = ICON_CATALOG.retro2004;
  Assert.ok(!retro.variants, "retro2004 is theme-agnostic");
  Assert.equal(
    resolvePreview(retro, "dark"),
    resolvePreview(retro, "light"),
    "a flat entry returns the same preview regardless of scheme"
  );
  Assert.equal(
    resolveResourceId(retro, "dark"),
    retro.iconResourceId,
    "a flat entry returns its single resource id regardless of scheme"
  );
});

/**
 * This test verifies the OS-theme runtime behaviour of a theme-aware icon:
 * apply() picks the variant matching the OS taskbar theme, and a
 * look-and-feel-changed notification re-applies the other variant when (and
 * only when) the OS theme actually flips.
 *
 * osColorScheme() reads the Windows registry, so we mock nsIWindowsRegKey for
 * the duration of this task only (to avoid disturbing other registry reads) and
 * drive SystemUsesLightTheme directly.
 */
add_task(skipOnMsix(), async function test_theme_change_reapplies_variant() {
  resetMocks();

  // The test flips this between OS_LIGHT/OS_DARK to simulate the user
  // changing their OS theme.
  let osTheme = OS_LIGHT;
  let regKeyMock = {
    QueryInterface: ChromeUtils.generateQI([Ci.nsIWindowsRegKey]),
    open() {},
    close() {},
    hasValue: name => name === "SystemUsesLightTheme",
    readIntValue: name => (name === "SystemUsesLightTheme" ? osTheme : 0),
  };
  let regCid = MockRegistrar.register(
    "@mozilla.org/windows-registry-key;1",
    regKeyMock
  );

  let { dark, light } = ICON_CATALOG.minimal.variants;

  try {
    // Startup registers the look-and-feel-changed observer.
    CustomIconManager.applyRuntimeOverrideForStartup();

    // Light OS theme -> Minimal applies the light variant.
    osTheme = OS_LIGHT;
    await CustomIconManager.apply("minimal");
    Assert.equal(
      shellServiceMock.setShortcutsIcon.lastCall.args[2],
      light.iconResourceId,
      "Minimal applies the light variant under a light OS theme"
    );
    Assert.ok(
      winTaskbarMock.setAllWindowIcons.calledWith(light.iconResourceId),
      "runtime window icon set to the light variant"
    );

    // Flip the OS to dark and notify -> the active Minimal re-applies as dark.
    osTheme = OS_DARK;
    shellServiceMock.setShortcutsIcon.resetHistory();
    winTaskbarMock.setAllWindowIcons.resetHistory();
    Services.obs.notifyObservers(null, "look-and-feel-changed");
    await TestUtils.waitForCondition(
      () => shellServiceMock.setShortcutsIcon.called,
      "icon re-applied after the OS theme flipped to dark"
    );
    Assert.equal(
      shellServiceMock.setShortcutsIcon.lastCall.args[2],
      dark.iconResourceId,
      "the dark variant is applied after the theme flips to dark"
    );

    // A notification with no actual theme change is a no-op (the
    // gLastAppliedScheme guard short-circuits before re-applying).
    shellServiceMock.setShortcutsIcon.resetHistory();
    Services.obs.notifyObservers(null, "look-and-feel-changed");
    Assert.ok(
      shellServiceMock.setShortcutsIcon.notCalled,
      "no re-apply when the OS theme is unchanged"
    );
  } finally {
    MockRegistrar.unregister(regCid);
    Services.prefs.clearUserPref(PREF_ICON_ID);
  }
});
