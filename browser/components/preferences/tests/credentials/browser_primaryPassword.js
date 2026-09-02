const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs"
);
const { OSKeyStore } = ChromeUtils.importESModule(
  "resource://gre/modules/OSKeyStore.sys.mjs"
);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["toolkit.osKeyStore.unofficialBuildOnlyLogin", ""]],
  });
});

add_task(async function () {
  let prefs = await openPreferencesViaOpenPreferencesAPI(
    "panePasswordsAutofill",
    {
      leaveOpen: true,
    }
  );
  is(
    prefs.selectedPane,
    "panePasswordsAutofill",
    "Passwords and Autofill pane was selected"
  );

  let doc = gBrowser.contentDocument;
  // Fake the subdialog and LoginHelper
  let win = doc.defaultView;
  let dialogURL = "";
  let dialogOpened = false;
  ChromeUtils.defineLazyGetter(win, "gSubDialog", () => ({
    open(aDialogURL, { closingCallback: aCallback }) {
      dialogOpened = true;
      dialogURL = aDialogURL;
      primaryPasswordSet = primaryPasswordNextState;
      aCallback();
    },
  }));

  let primaryPasswordSet = false;
  win.LoginHelper = {
    isPrimaryPasswordSet() {
      return primaryPasswordSet;
    },
    getOSAuthEnabled() {
      return true; // Since enabled by default.
    },
    // Simulate non-enterprise-managed browser
    isEnterpriseManagedPrimaryPassword() {
      return false;
    },
  };

  let primaryPasswordNotSet = doc.querySelector("#primaryPasswordNotSet");
  primaryPasswordNotSet.scrollIntoView();
  ok(
    primaryPasswordNotSet,
    "'Primary password not set' control should be shown by default"
  );
  let button = doc.getElementById("addPrimaryPassword");

  let primaryPasswordNextState = false;
  if (OSKeyStoreTestUtils.canTestOSKeyStoreLogin() && OSKeyStore.canReauth()) {
    let osAuthDialogShown = OSKeyStoreTestUtils.waitForOSKeyStoreLogin(false);
    button.click();
    info("waiting for os auth dialog to appear and get canceled");
    await osAuthDialogShown;
    ok(!dialogOpened, "the dialog should not have opened");
    ok(
      !dialogURL,
      "the changemp dialog should not have been opened when the os auth dialog is canceled"
    );
  }

  let primaryPasswordSetCtrl = doc.querySelector("#primaryPasswordSet");
  primaryPasswordNextState = true;
  if (OSKeyStoreTestUtils.canTestOSKeyStoreLogin() && OSKeyStore.canReauth()) {
    let osAuthDialogShown = OSKeyStoreTestUtils.waitForOSKeyStoreLogin(true);
    button.click();
    info("waiting for os auth dialog to appear");
    await osAuthDialogShown;
    info("waiting for dialogURL to get set");
    await TestUtils.waitForCondition(
      () => dialogURL,
      "wait for open to get called asynchronously"
    );
    is(
      dialogURL,
      "chrome://mozapps/content/preferences/changemp.xhtml",
      "clicking on the checkbox should open the primary password dialog"
    );
  } else {
    primaryPasswordSet = true;
    doc.defaultView.gPrivacyPane._initMasterPasswordUI();
    await TestUtils.waitForCondition(
      () => !button.disabled,
      "waiting for primary password button to get enabled"
    );
  }
  ok(
    primaryPasswordSetCtrl,
    "'primary password set control' should be visible now"
  );

  dialogURL = "";
  button.click();
  await TestUtils.waitForCondition(
    () => dialogURL,
    "wait for open to get called asynchronously"
  );
  is(
    dialogURL,
    "chrome://mozapps/content/preferences/changemp.xhtml",
    "clicking on the button should open the primary password dialog"
  );

  // Confirm that we won't automatically respond to the dialog,
  // since we don't expect a dialog here, we want the test to fail if one appears.
  is(
    Services.prefs.getStringPref(
      "toolkit.osKeyStore.unofficialBuildOnlyLogin",
      ""
    ),
    "",
    "Pref should be set to an empty string"
  );

  let removePrimaryPasswordButton = doc.querySelector(
    "#turnOffPrimaryPassword"
  );
  primaryPasswordNextState = false;
  dialogURL = "";
  removePrimaryPasswordButton.click();
  is(
    dialogURL,
    "chrome://mozapps/content/preferences/removemp.xhtml",
    "clicking on the checkbox to uncheck primary password should show the removal dialog"
  );

  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

// When the primary password is managed by enterprise storage encryption the
// user must not be able to add, change or turn it off from the redesigned
// Passwords and Autofill settings.
add_task(async function enterprise_managed_primary_password_is_disabled() {
  await openPreferencesViaOpenPreferencesAPI("panePasswordsAutofill", {
    leaveOpen: true,
  });

  let doc = gBrowser.contentDocument;
  let win = doc.defaultView;

  // Simulate an enterprise-managed browser whose primary password is set
  // transparently and cannot be modified by the user.
  win.LoginHelper = {
    isPrimaryPasswordSet() {
      return true;
    },
    getOSAuthEnabled() {
      return true;
    },
    isEnterpriseManagedPrimaryPassword() {
      return true;
    },
  };

  // Force the primary-password settings to re-evaluate their disabled state.
  Services.obs.notifyObservers(null, "passwordmgr-primary-pw-changed");

  let addButton = doc.getElementById("addPrimaryPassword");
  let changeButton = doc.getElementById("changePrimaryPassword");
  let turnOffButton = doc.querySelector("#turnOffPrimaryPassword");

  await TestUtils.waitForCondition(
    () => addButton.disabled && changeButton.disabled && turnOffButton.disabled,
    "waiting for the primary password controls to become disabled"
  );

  ok(
    addButton.disabled,
    "'Add primary password' button should be disabled when enterprise-managed"
  );
  ok(
    changeButton.disabled,
    "'Change primary password' button should be disabled when enterprise-managed"
  );
  ok(
    turnOffButton.disabled,
    "'Turn off primary password' button should be disabled when enterprise-managed"
  );

  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});
