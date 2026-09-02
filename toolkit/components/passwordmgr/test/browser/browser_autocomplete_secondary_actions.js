const TEST_ORIGIN = "https://example.org";
const TEST_URL_PATH = `${TEST_ORIGIN}${DIRECTORY_PATH}form_basic_login.html`;
const PREF = "browser.autocomplete.removeRecords.enabled";

const LOGINS_DATA = [
  { origin: TEST_ORIGIN, username: "user1", password: "pass1" },
  { origin: TEST_ORIGIN, username: "user2", password: "pass2" },
];

add_setup(async () => {
  await Services.logins.addLogins(
    LOGINS_DATA.map(login => LoginTestUtils.testData.formLogin(login))
  );
});

function getSecondaryAction(popup, index) {
  const item = popup.firstChild.getItemAtIndex(index);
  const rowItem = item.querySelector("autocomplete-row-item");
  const button = rowItem.shadowRoot.querySelector(
    "moz-button.secondary-action"
  );
  return { item, rowItem, button };
}

async function selectRow(item, index) {
  for (let i = 0; i <= index; i++) {
    await EventUtils.synthesizeKey("KEY_ArrowDown");
  }
  await TestUtils.waitForCondition(
    () => item.hasAttribute("selected"),
    "Wait for the login row to become active"
  );
}

add_task(async function test_edit_icon_when_pref_disabled() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, false]] });
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: TEST_URL_PATH },
    async function (browser) {
      const popup = document.getElementById("PopupAutoComplete");
      await openACPopup(popup, browser, "#form-basic-username");

      const { rowItem, button } = getSecondaryAction(popup, 0);

      Assert.equal(
        rowItem.actions.secondary.type,
        "edit",
        "Login row keeps the edit secondary action when the pref is off"
      );
      Assert.ok(
        button.iconSrc.endsWith("edit.svg"),
        "The secondary action shows the edit icon"
      );

      await closePopup(popup);
    }
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_flyout_when_pref_enabled() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: TEST_URL_PATH },
    async function (browser) {
      const popup = document.getElementById("PopupAutoComplete");
      await openACPopup(popup, browser, "#form-basic-username");

      const { item, rowItem, button } = getSecondaryAction(popup, 0);

      Assert.equal(
        rowItem.actions.secondary.type,
        "menupopup",
        "Login row shows the flyout secondary action when the pref is on"
      );
      Assert.ok(
        button.iconSrc.endsWith("more.svg"),
        "The secondary action shows the more icon"
      );

      await selectRow(item, 0);
      Assert.ok(
        button.checkVisibility({ checkVisibilityCSS: true }),
        "Secondary action is visible when the row is active"
      );

      const [editAction, deleteAction] = rowItem.actions.secondary.actions;

      EventUtils.synthesizeMouseAtCenter(button, {});

      const menupopup = await TestUtils.waitForCondition(
        () =>
          [...document.querySelectorAll("menupopup")].find(m =>
            [...m.querySelectorAll("menuitem")].some(
              mi => mi.getAttribute("label") === editAction.label
            )
          ),
        "Wait for the flyout menu to open"
      );

      const labels = [...menupopup.querySelectorAll("menuitem")].map(mi =>
        mi.getAttribute("label")
      );
      Assert.deepEqual(
        labels,
        [editAction.label, deleteAction.label],
        "Flyout contains the Edit and Delete items"
      );

      Assert.ok(
        popup.contains(menupopup),
        "The flyout is hosted inside the autocomplete panel"
      );
      Assert.equal(popup.state, "open", "The autocomplete popup stays open");

      const menuHidden = BrowserTestUtils.waitForEvent(
        menupopup,
        "popuphiding"
      );
      menupopup.hidePopup();
      await menuHidden;

      await TestUtils.waitForCondition(
        () => !popup.contains(menupopup),
        "The flyout menupopup is removed after closing"
      );
      Assert.equal(
        popup.state,
        "open",
        "The autocomplete popup remains open after the flyout closes"
      );

      // The flyout lives inside the panel, so its popup events bubble up to
      // the panel's own listeners and to AutoCompleteParent's. Neither may
      // mistake them for the panel itself opening or closing, otherwise the
      // actor tears itself down and every later secondary action no-ops.
      Assert.ok(
        popup.mPopupOpen,
        "The panel still considers itself open after the flyout closes"
      );
      const { AutoCompleteParent } = ChromeUtils.importESModule(
        "moz-src:///toolkit/actors/AutoCompleteParent.sys.mjs"
      );
      Assert.ok(
        AutoCompleteParent.getCurrentActor(),
        "The autocomplete actor is still current after the flyout closes"
      );

      await closePopup(popup);
    }
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_flyout_opens_via_keyboard() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: TEST_URL_PATH },
    async function (browser) {
      const popup = document.getElementById("PopupAutoComplete");
      await openACPopup(popup, browser, "#form-basic-username");

      const { item, rowItem } = getSecondaryAction(popup, 0);
      await selectRow(item, 0);

      await EventUtils.synthesizeKey("KEY_Tab");
      await TestUtils.waitForCondition(
        () => rowItem.hasAttribute("subfocused"),
        "Wait for the secondary action to become sub-focused"
      );

      const editLabel = rowItem.actions.secondary.actions[0].label;
      await EventUtils.synthesizeKey("KEY_Enter");

      const menupopup = await TestUtils.waitForCondition(
        () =>
          [...document.querySelectorAll("menupopup")].find(m =>
            [...m.querySelectorAll("menuitem")].some(
              mi => mi.getAttribute("label") === editLabel
            )
          ),
        "Wait for the flyout to open from the keyboard"
      );

      Assert.equal(popup.state, "open", "The autocomplete popup stays open");

      const menuHidden = BrowserTestUtils.waitForEvent(
        menupopup,
        "popuphiding"
      );
      menupopup.hidePopup();
      await menuHidden;

      await closePopup(popup);
    }
  );
  await SpecialPowers.popPrefEnv();
});

// The action button must stay pinned to the row for as long as the flyout is
// open, not only while the row is hovered or selected.
add_task(async function test_action_button_persists_while_flyout_open() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: TEST_URL_PATH },
    async function (browser) {
      const popup = document.getElementById("PopupAutoComplete");
      await openACPopup(popup, browser, "#form-basic-username");

      const { item, rowItem, button } = getSecondaryAction(popup, 0);
      await selectRow(item, 0);

      const editLabel = rowItem.actions.secondary.actions[0].label;
      // The button only becomes hittable once the selected row has rendered it
      // visible, which can lag the row's "selected" attribute.
      await TestUtils.waitForCondition(
        () => button.checkVisibility({ checkVisibilityCSS: true }),
        "Wait for the secondary action button to be visible"
      );
      EventUtils.synthesizeMouseAtCenter(button, {});

      const menupopup = await TestUtils.waitForCondition(
        () =>
          [...document.querySelectorAll("menupopup")].find(m =>
            [...m.querySelectorAll("menuitem")].some(
              mi => mi.getAttribute("label") === editLabel
            )
          ),
        "Wait for the flyout menu to open"
      );

      Assert.ok(
        rowItem.hasAttribute("menuopen"),
        "The row is marked open while the flyout is showing"
      );

      const menuHidden = BrowserTestUtils.waitForEvent(
        menupopup,
        "popuphiding"
      );
      menupopup.hidePopup();
      await menuHidden;

      await TestUtils.waitForCondition(
        () => !rowItem.hasAttribute("menuopen"),
        "The open marker is cleared after the flyout closes"
      );

      await closePopup(popup);
    }
  );
  await SpecialPowers.popPrefEnv();
});

// Popup should route each item to its own action index through
// the parent's dispatch path.
add_task(async function test_flyout_actions_dispatch_by_index() {
  const { AutoCompleteParent } = ChromeUtils.importESModule(
    "moz-src:///toolkit/actors/AutoCompleteParent.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: TEST_URL_PATH },
    async function (browser) {
      const popup = document.getElementById("PopupAutoComplete");
      await openACPopup(popup, browser, "#form-basic-username");

      const { item, rowItem } = getSecondaryAction(popup, 0);
      await selectRow(item, 0);

      const calls = [];
      const original = AutoCompleteParent.prototype.selectAutoCompleteEntry;
      AutoCompleteParent.prototype.selectAutoCompleteEntry = function (
        ...args
      ) {
        calls.push(args);
        return original.apply(this, args);
      };

      try {
        const { actions } = rowItem.actions.secondary;
        Assert.equal(actions.length, 2, "Flyout has two actions");

        actions[0].action();
        Assert.deepEqual(
          calls.at(-1),
          [true, 0],
          "First flyout item dispatches secondary action index 0"
        );

        actions[1].action();
        Assert.deepEqual(
          calls.at(-1),
          [true, 1],
          "Second flyout item dispatches secondary action index 1"
        );
      } finally {
        AutoCompleteParent.prototype.selectAutoCompleteEntry = original;
      }

      await closePopup(popup);
    }
  );
  await SpecialPowers.popPrefEnv();
});

// Closing the autocomplete panel should tear down any flyout a row left open.
add_task(async function test_flyout_closes_with_panel() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: TEST_URL_PATH },
    async function (browser) {
      const popup = document.getElementById("PopupAutoComplete");
      await openACPopup(popup, browser, "#form-basic-username");

      const { item, rowItem, button } = getSecondaryAction(popup, 0);
      await selectRow(item, 0);

      const editLabel = rowItem.actions.secondary.actions[0].label;
      // The button only becomes hittable once the selected row has rendered it
      // visible, which can lag the row's "selected" attribute.
      await TestUtils.waitForCondition(
        () => button.checkVisibility({ checkVisibilityCSS: true }),
        "Wait for the secondary action button to be visible"
      );
      EventUtils.synthesizeMouseAtCenter(button, {});

      const menupopup = await TestUtils.waitForCondition(
        () =>
          [...document.querySelectorAll("menupopup")].find(m =>
            [...m.querySelectorAll("menuitem")].some(
              mi => mi.getAttribute("label") === editLabel
            )
          ),
        "Wait for the flyout menu to open"
      );

      await closePopup(popup);

      await TestUtils.waitForCondition(
        () => !popup.contains(menupopup),
        "The flyout is removed when the autocomplete panel closes"
      );
      Assert.ok(
        !rowItem.hasAttribute("menuopen"),
        "The row's open marker is cleared when the panel closes"
      );
    }
  );
  await SpecialPowers.popPrefEnv();
});
