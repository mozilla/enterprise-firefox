/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

const { LoginTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/LoginTestUtils.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const PRIMARY_PASSWORD_CONTROL_IDS = [
  "primaryPasswordNotSet",
  "usePrimaryPassword",
  "addPrimaryPassword",
  "primaryPasswordSet",
  "statusPrimaryPassword",
  "turnOffPrimaryPassword",
  "changePrimaryPassword",
];

function isShown(doc, id) {
  return [...doc.querySelectorAll(`#${id}`)].some(el =>
    BrowserTestUtils.isVisible(el)
  );
}

add_task(async function test_managed_primary_password_controls_hidden() {
  await LoginTestUtils.primaryPassword.enable(true);
  sinon.stub(LoginHelper, "isEnterpriseManagedPrimaryPassword").returns(true);
  registerCleanupFunction(async () => {
    sinon.restore();
    await LoginTestUtils.primaryPassword.disable();
  });

  let pane = "panePasswordsAutofill";
  let prefs = await openPreferencesViaOpenPreferencesAPI(pane, {
    leaveOpen: true,
  });
  is(prefs.selectedPane, pane, `${pane} was selected`);

  let doc = gBrowser.contentDocument;
  await TestUtils.waitForCondition(
    () => isShown(doc, "breachAlerts"),
    "Breach alerts control should be shown"
  );

  for (let id of PRIMARY_PASSWORD_CONTROL_IDS) {
    ok(!isShown(doc, id), `#${id} should be hidden`);
  }

  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});
