/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { UIState } = ChromeUtils.importESModule(
  "resource://services-sync/UIState.sys.mjs"
);

const PASSWORDS_PREF = "services.sync.engine.passwords";
const CREDITCARDS_PREF = "services.sync.engine.creditcards";
const ORG_ICON = "chrome://global/skin/icons/organizational-unit.svg";

function checkNotice(notice, expectedL10nId, description) {
  ok(notice, `${description}: the notice is present`);
  ok(!notice.hidden, `${description}: the notice is visible`);
  is(
    notice.getAttribute("data-l10n-id"),
    expectedL10nId,
    `${description}: the expected string is used`
  );
  is(notice.iconSrc, ORG_ICON, `${description}: the org unit icon is used`);
  is(
    notice.shadowRoot.querySelector("img.icon").getAttribute("src"),
    ORG_ICON,
    `${description}: the org unit icon is rendered`
  );
}

// The notice must appear whether or not the user is signed in, since both
// states offer a way to turn Sync on.
add_task(async function test_notice_on_pane_signed_out() {
  await runSyncPaneTest({ status: UIState.STATUS_NOT_CONFIGURED }, doc => {
    checkNotice(
      doc.getElementById("syncManagedNotice"),
      "sync-managed-pane",
      "Signed out"
    );
  });
});

add_task(async function test_notice_on_pane_signed_in() {
  await runSyncPaneTest(
    { status: UIState.STATUS_SIGNED_IN, email: "foo@example.com" },
    doc => {
      checkNotice(
        doc.getElementById("syncManagedNotice"),
        "sync-managed-pane",
        "Signed in"
      );
    }
  );
});

// This manifest turns the settings redesign off, so cover the other pane
// variant explicitly: they are two separate implementations.
add_task(async function test_notice_on_redesigned_pane() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.settings-redesign.enabled", true]],
  });
  await runSyncPaneTest(
    { status: UIState.STATUS_SIGNED_IN, email: "foo@example.com" },
    doc => {
      checkNotice(
        doc.getElementById("syncManagedNotice"),
        "sync-managed-pane",
        "Redesigned pane"
      );
    }
  );
  await SpecialPowers.popPrefEnv();
});

async function withSyncDialog(callback) {
  await openPreferencesViaOpenPreferencesAPI("paneSync", { leaveOpen: true });
  let dialog = await openAndLoadSubDialog(
    "chrome://browser/content/preferences/dialogs/syncChooseWhatToSync.xhtml",
    null,
    {}
  );
  try {
    await callback(dialog.document);
  } finally {
    dialog.document.getElementById("syncChooseOptions").cancelDialog();
    BrowserTestUtils.removeTab(gBrowser.selectedTab);
  }
}

add_task(async function test_notice_in_dialog_when_opt_in_possible() {
  await withSyncDialog(doc => {
    // Nothing is locked, so the user can still opt in and the notice says so.
    checkNotice(
      doc.getElementById("syncManagedNotice"),
      "sync-managed-dialog",
      "Dialog, unlocked"
    );
  });
});

add_task(async function test_notice_in_dialog_when_locked_off() {
  // Policy can lock these engines off, which disables the checkboxes. The
  // notice must not then claim they can be turned on here.
  Services.prefs.getDefaultBranch("").setBoolPref(PASSWORDS_PREF, false);
  Services.prefs.getDefaultBranch("").setBoolPref(CREDITCARDS_PREF, false);
  Services.prefs.lockPref(PASSWORDS_PREF);
  Services.prefs.lockPref(CREDITCARDS_PREF);
  registerCleanupFunction(() => {
    Services.prefs.unlockPref(PASSWORDS_PREF);
    Services.prefs.unlockPref(CREDITCARDS_PREF);
  });

  await withSyncDialog(doc => {
    checkNotice(
      doc.getElementById("syncManagedNotice"),
      "sync-managed-dialog-locked",
      "Dialog, locked off"
    );
  });

  Services.prefs.unlockPref(PASSWORDS_PREF);
  Services.prefs.unlockPref(CREDITCARDS_PREF);
});

// Only one of the two needs to be unlocked for the opt-in wording to hold.
add_task(async function test_notice_in_dialog_when_partially_locked() {
  Services.prefs.getDefaultBranch("").setBoolPref(CREDITCARDS_PREF, false);
  Services.prefs.lockPref(CREDITCARDS_PREF);
  registerCleanupFunction(() => Services.prefs.unlockPref(CREDITCARDS_PREF));

  await withSyncDialog(doc => {
    checkNotice(
      doc.getElementById("syncManagedNotice"),
      "sync-managed-dialog",
      "Dialog, only payment methods locked"
    );
  });

  Services.prefs.unlockPref(CREDITCARDS_PREF);
});
