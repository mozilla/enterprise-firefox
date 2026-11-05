/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const { LoginTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/LoginTestUtils.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const TOKEN_BUTTON_IDS = ["login_button", "logout_button", "change_pw_button"];

add_task(async function test_managed_internal_key_token_buttons_disabled() {
  await LoginTestUtils.primaryPassword.enable(true);
  sinon.stub(LoginHelper, "isEnterpriseManagedPrimaryPassword").returns(true);
  registerCleanupFunction(async () => {
    sinon.restore();
    await LoginTestUtils.primaryPassword.disable();
  });

  let win = window.openDialog(
    "chrome://pippki/content/device_manager.xhtml",
    "",
    ""
  );
  await TestUtils.topicObserved("device-manager-loaded");

  let tree = win.document.getElementById("device_tree");
  let found = false;
  for (let i = 0; i < tree.view.rowCount; i++) {
    tree.view.selection.select(i);
    if (win.selected_slot?.getToken().isInternalKeyToken) {
      found = true;
      break;
    }
  }
  ok(found, "Selected the internal key token");

  for (let id of TOKEN_BUTTON_IDS) {
    ok(
      win.document.getElementById(id).hasAttribute("disabled"),
      `#${id} should be disabled for the internal key token`
    );
  }

  await BrowserTestUtils.closeWindow(win);
});
