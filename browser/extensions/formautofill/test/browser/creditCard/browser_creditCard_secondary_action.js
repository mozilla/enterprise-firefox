"use strict";

const PREF = "browser.autocomplete.removeRecords.enabled";
const AC_L10N = new Localization(
  ["toolkit/main-window/autocomplete.ftl"],
  true
);
const CC_URL =
  "https://example.org/browser/browser/extensions/formautofill/test/browser/creditCard/autocomplete_creditcard_basic.html";

// Name the flyout item by its string rather than its position, so adding
// another action to the menu later does not move this test's target.
const DELETE_LABEL = AC_L10N.formatValueSync(
  "autocomplete-delete-payment-method"
);

add_setup(async function setup_storage() {
  await setStorage(TEST_CREDIT_CARD_1);
});

add_task(async function test_no_secondary_action_when_pref_disabled() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, false]] });
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: CC_URL },
    async browser => {
      await openPopupOn(browser, "#cc-number");
      const rowItem = getDisplayedPopupItems(browser)[0].querySelector(
        "autocomplete-row-item"
      );
      is(
        rowItem.actions.secondary,
        null,
        "Payment rows have no secondary action when the pref is off"
      );
      ok(
        !rowItem.shadowRoot.querySelector("moz-button.secondary-action"),
        "No secondary action button is rendered"
      );
      await closePopup(browser);
    }
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_flyout_when_pref_enabled() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: CC_URL },
    async browser => {
      await openPopupOn(browser, "#cc-number");
      const rowItem = getDisplayedPopupItems(browser)[0].querySelector(
        "autocomplete-row-item"
      );
      is(
        rowItem.actions.secondary.type,
        "menupopup",
        "Payment rows show a flyout secondary action when the pref is on"
      );
      is(
        rowItem.actions.secondary.actions.length,
        2,
        "The flyout has an edit and a delete item"
      );
      const button = rowItem.shadowRoot.querySelector(
        "moz-button.secondary-action"
      );
      ok(
        button.iconSrc.endsWith("more.svg"),
        "The secondary action shows the more icon"
      );
      await closePopup(browser);
    }
  );
  await SpecialPowers.popPrefEnv();
});

async function selectFirstRow(browser, item) {
  await BrowserTestUtils.synthesizeKey("VK_DOWN", {}, browser);
  await TestUtils.waitForCondition(
    () => item.hasAttribute("selected"),
    "Wait for the first row to become active"
  );
}

async function openFlyout(popup, rowItem, label) {
  const button = rowItem.shadowRoot.querySelector(
    "moz-button.secondary-action"
  );

  const menuShown = BrowserTestUtils.waitForEvent(
    popup,
    "popupshown",
    false,
    event => event.target.localName == "menupopup"
  );
  const panelHidden = BrowserTestUtils.waitForEvent(
    popup,
    "popuphidden",
    false,
    event => event.target == popup
  );

  await EventUtils.promiseElementReadyForUserInput(button, window, info);

  await TestUtils.waitForCondition(
    () => button.checkVisibility({ checkVisibilityCSS: true }),
    "Wait for the secondary action button to be visible"
  );
  EventUtils.synthesizeMouseAtCenter(button, {}, window);

  const event = await Promise.race([menuShown, panelHidden]);
  Assert.equal(
    event.type,
    "popupshown",
    "The click reached the secondary action button instead of the row"
  );

  const menupopup = event.target;
  Assert.ok(
    [...menupopup.querySelectorAll("menuitem")].some(
      mi => mi.getAttribute("label") === label
    ),
    "The flyout belongs to the row's secondary action"
  );
  return menupopup;
}

// Opens the dropdown and its delete flyout with device sign in stubbed out, so
// the tests below never depend on a real OS prompt. `verifyArgs` records what
// the parent asked for, and `restore` puts the real implementation back.
async function openDeleteFlyout(browser, { verified = true } = {}) {
  const originalVerify = FormAutofillUtils.verifyUserOSAuth;
  const verifyArgs = [];
  FormAutofillUtils.verifyUserOSAuth = (...args) => {
    verifyArgs.push(args);
    return Promise.resolve(verified);
  };

  await openPopupOn(browser, "#cc-number");
  const item = getDisplayedPopupItems(browser)[0];
  const rowItem = item.querySelector("autocomplete-row-item");
  await selectFirstRow(browser, item);

  const menupopup = await openFlyout(
    browser.autoCompletePopup,
    rowItem,
    DELETE_LABEL
  );
  const menuitem = [...menupopup.querySelectorAll("menuitem")].find(
    mi => mi.getAttribute("label") === DELETE_LABEL
  );

  return {
    menupopup,
    menuitem,
    verifyArgs,
    restore: () => {
      FormAutofillUtils.verifyUserOSAuth = originalVerify;
    },
  };
}

async function acceptRemoval(menupopup, menuitem) {
  await withStorageChange("remove", async () => {
    const dialogClosed = BrowserTestUtils.promiseAlertDialog("accept");
    menupopup.activateItem(menuitem);
    await dialogClosed;
  });
}

add_task(async function test_delete_asks_for_device_sign_in_then_confirms() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  let sawDialog = false;

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: CC_URL },
    async browser => {
      const { menupopup, menuitem, verifyArgs, restore } =
        await openDeleteFlyout(browser, { verified: true });

      const dialogClosed = BrowserTestUtils.promiseAlertDialog(
        null,
        undefined,
        {
          callback: win => {
            sawDialog = true;
            const [title, message] = AC_L10N.formatValuesSync([
              { id: "autocomplete-delete-payment-method-title" },
              { id: "autocomplete-remove-record-message" },
            ]);
            is(
              win.document.getElementById("infoTitle").textContent,
              title,
              "The confirmation asks whether to remove the payment method"
            );
            is(
              win.document.getElementById("infoBody").textContent,
              message,
              "The confirmation warns the action cannot be undone"
            );
            win.document.querySelector("dialog").getButton("cancel").click();
          },
        }
      );

      menupopup.activateItem(menuitem);
      await dialogClosed;
      await TestUtils.waitForCondition(
        () => !menupopup.isConnected,
        "Wait for the flyout to be torn down"
      );
      await TestUtils.waitForCondition(
        () => browser.autoCompletePopup.popupOpen,
        "Wait for the dropdown to come back after the confirmation"
      );

      const { FormAutofill } = ChromeUtils.importESModule(
        "resource://autofill/FormAutofill.sys.mjs"
      );
      is(verifyArgs.length, 1, "Device sign in was requested");
      is(
        verifyArgs[0][0],
        FormAutofill.AUTOFILL_CREDITCARDS_OS_AUTH_LOCKED_PREF,
        "Device sign in is gated on the payment methods reauth pref"
      );
      is(
        verifyArgs[0][4],
        false,
        "Removal does not let the OS key store generate a key it never reads"
      );
      ok(sawDialog, "The confirmation dialog was shown");
      ok(
        browser.autoCompletePopup.popupOpen,
        "The dropdown is restored once the confirmation is dismissed"
      );

      const cards = await getCreditCards();
      is(
        cards.length,
        1,
        "Cancelling the confirmation leaves the payment method in place"
      );

      restore();
      await closePopup(browser);
    }
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_delete_skips_confirm_when_device_sign_in_fails() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  let sawDialog = false;
  const observer = () => {
    sawDialog = true;
  };
  Services.obs.addObserver(observer, "common-dialog-loaded");

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: CC_URL },
    async browser => {
      const { menupopup, menuitem, verifyArgs, restore } =
        await openDeleteFlyout(browser, { verified: false });

      menupopup.activateItem(menuitem);
      await TestUtils.waitForCondition(
        () => verifyArgs.length,
        "Wait for device sign in to be requested"
      );
      await TestUtils.waitForTick();

      ok(
        !sawDialog,
        "No confirmation is shown when device sign in is declined"
      );
      is(
        (await getCreditCards()).length,
        1,
        "Declining device sign in leaves the payment method in place"
      );

      restore();
      await closePopup(browser);
    }
  );
  Services.obs.removeObserver(observer, "common-dialog-loaded");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_delete_removes_the_payment_method() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  await removeAllRecords();
  await setStorage(TEST_CREDIT_CARD_1, TEST_CREDIT_CARD_2);
  const before = await getCreditCards();

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: CC_URL },
    async browser => {
      const { menupopup, menuitem, restore } = await openDeleteFlyout(browser);
      const rowCount = getDisplayedPopupItems(browser).length;

      await acceptRemoval(menupopup, menuitem);
      restore();

      const remaining = await getCreditCards();
      is(
        remaining.length,
        1,
        "Confirming the removal deleted one payment method"
      );
      ok(
        before.some(card => !remaining.some(kept => kept.guid == card.guid)),
        "Exactly one of the stored payment methods is gone"
      );

      await TestUtils.waitForCondition(
        () => browser.autoCompletePopup.popupOpen,
        "Wait for the dropdown to come back after the removal"
      );
      await TestUtils.waitForCondition(
        () => getDisplayedPopupItems(browser).length == rowCount - 1,
        "Wait for the restored dropdown to drop the removed row"
      );

      await closePopup(browser);
    }
  );
  await removeAllRecords();
  await SpecialPowers.popPrefEnv();
});

add_task(
  async function test_deleting_the_last_payment_method_closes_the_dropdown() {
    await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
    await removeAllRecords();
    await setStorage(TEST_CREDIT_CARD_1);

    await BrowserTestUtils.withNewTab(
      { gBrowser, url: CC_URL },
      async browser => {
        const { menupopup, menuitem, restore } =
          await openDeleteFlyout(browser);

        await acceptRemoval(menupopup, menuitem);
        restore();

        is(
          (await getCreditCards()).length,
          0,
          "The last payment method was removed from storage"
        );
        await TestUtils.waitForCondition(
          () => !browser.autoCompletePopup.popupOpen && !menupopup.isConnected,
          "Wait for the dropdown and its flyout to be torn down"
        );
      }
    );
    await removeAllRecords();
    await SpecialPowers.popPrefEnv();
  }
);

add_task(async function test_delete_refuses_an_unknown_guid() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  await removeAllRecords();
  await setStorage(TEST_CREDIT_CARD_1);

  const originalVerify = FormAutofillUtils.verifyUserOSAuth;
  FormAutofillUtils.verifyUserOSAuth = () => Promise.resolve(true);

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: CC_URL },
    async browser => {
      await openPopupOn(browser, "#cc-number");

      const actor =
        browser.browsingContext.currentWindowGlobal.getActor("FormAutofill");
      const dialogClosed = BrowserTestUtils.promiseAlertDialog("accept");
      await actor.onAutoCompleteEntrySelected("FormAutofill:DeleteCreditCard", {
        guid: "no-such-guid",
      });
      await dialogClosed;

      is(
        (await getCreditCards()).length,
        1,
        "A guid that names no stored payment method removes nothing"
      );

      await TestUtils.waitForCondition(
        () => browser.autoCompletePopup.popupOpen,
        "Wait for the dropdown to come back after the refused removal"
      );
      await closePopup(browser);
    }
  );
  FormAutofillUtils.verifyUserOSAuth = originalVerify;
  await removeAllRecords();
  await SpecialPowers.popPrefEnv();
});

// Removal reads no card number, so a card the current key can no longer open
// must still be removable -- which is when a user most wants to be rid of it.
// A decrypt that always fails stands in for that card: rotating the real store
// label would outlive this file and break the next one to save a card.
add_task(async function test_delete_removes_a_card_that_cannot_be_decrypted() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  await removeAllRecords();
  await setStorage(TEST_CREDIT_CARD_1);

  const originalDecrypt = OSKeyStore.decrypt;
  let decryptCalls = 0;
  OSKeyStore.decrypt = () => {
    decryptCalls++;
    return Promise.reject(Components.Exception("", Cr.NS_ERROR_FAILURE));
  };

  try {
    await BrowserTestUtils.withNewTab(
      { gBrowser, url: CC_URL },
      async browser => {
        const { menupopup, menuitem, restore } =
          await openDeleteFlyout(browser);

        await acceptRemoval(menupopup, menuitem);
        restore();

        is(
          (await getCreditCards()).length,
          0,
          "A payment method whose number cannot be decrypted is still removed"
        );
        is(decryptCalls, 0, "The removal never reached for the card number");
      }
    );
  } finally {
    OSKeyStore.decrypt = originalDecrypt;
  }
  await removeAllRecords();
  await SpecialPowers.popPrefEnv();
});
