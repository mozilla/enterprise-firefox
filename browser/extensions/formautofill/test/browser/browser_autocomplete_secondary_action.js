"use strict";

const PREF = "browser.autocomplete.removeRecords.enabled";

add_setup(async function setup_storage() {
  await setStorage(TEST_ADDRESS_1);
});

add_task(async function test_no_secondary_action_when_pref_disabled() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, false]] });
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: FORM_URL },
    async browser => {
      await openPopupOn(browser, "#organization");
      const rowItem = getDisplayedPopupItems(browser)[0].querySelector(
        "autocomplete-row-item"
      );
      is(
        rowItem.actions.secondary,
        null,
        "Address rows have no secondary action when the pref is off"
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
    { gBrowser, url: FORM_URL },
    async browser => {
      await openPopupOn(browser, "#organization");
      const items = getDisplayedPopupItems(browser);

      const rowItem = items[0].querySelector("autocomplete-row-item");
      is(
        rowItem.actions.secondary.type,
        "menupopup",
        "Address rows show a flyout secondary action when the pref is on"
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

      // The "Manage addresses" footer row must not get a secondary action.
      const footer = items.at(-1).querySelector("autocomplete-row-item");
      is(
        footer.actions.secondary,
        null,
        "The manage footer row has no secondary action"
      );

      await closePopup(browser);
    }
  );
  await SpecialPowers.popPrefEnv();
});
