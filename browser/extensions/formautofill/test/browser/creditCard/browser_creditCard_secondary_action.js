"use strict";

const PREF = "browser.autocomplete.removeRecords.enabled";
const CC_URL =
  "https://example.org/browser/browser/extensions/formautofill/test/browser/creditCard/autocomplete_creditcard_basic.html";

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
