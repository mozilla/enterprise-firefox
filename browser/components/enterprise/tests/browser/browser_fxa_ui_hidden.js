/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// The FxA account is provisioned by the console on Firefox Enterprise, so the
// toolbar button and the app menu account row are hidden.

const { CustomizableUITestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/CustomizableUITestUtils.sys.mjs"
);
const { UIState } = ChromeUtils.importESModule(
  "resource://services-sync/UIState.sys.mjs"
);

const gCUITestUtils = new CustomizableUITestUtils(window);

add_task(function test_fxa_toolbar_pref_is_locked_off() {
  const pref = "identity.fxaccounts.toolbar.enabled";
  Assert.ok(Services.prefs.prefIsLocked(pref), `${pref} is locked`);
  Assert.ok(!Services.prefs.getBoolPref(pref), `${pref} is disabled`);
});

add_task(async function test_fxa_ui_hidden_when_signed_in() {
  registerCleanupFunction(() => gSync.updateAllUI(UIState.get()));
  gSync.updateAllUI({
    status: UIState.STATUS_SIGNED_IN,
    syncEnabled: true,
    email: "foo@bar.com",
    displayName: "Foo Bar",
    lastSync: new Date(),
    syncing: false,
  });

  Assert.ok(
    BrowserTestUtils.isHidden(
      document.getElementById("fxa-toolbar-menu-button")
    ),
    "FxA toolbar button is hidden"
  );

  await gCUITestUtils.openMainMenu();
  for (const id of ["appMenu-fxa-status2", "appMenu-fxa-separator"]) {
    Assert.ok(
      BrowserTestUtils.isHidden(PanelMultiView.getViewNode(document, id)),
      `${id} is hidden in the app menu`
    );
  }
  await gCUITestUtils.hideMainMenu();
});
