/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.contextMenu.featureGate", true]],
  });

  // Add visits so that it can be autofilled.
  await PlacesTestUtils.addVisits([
    {
      uri: "https://example.com/",
      transition: PlacesUtils.history.TRANSITION_TYPED,
    },
  ]);
  await PlacesFrecencyRecalculator.recalculateAnyOutdatedFrecencies();

  registerCleanupFunction(async () => {
    await PlacesUtils.history.clear();
  });
});

add_task(async function basic() {
  const TEST_CASES = [
    {
      preferences: [["browser.tabs.loadInBackground", true]],
      menuItemId: "urlbar-view-context-menu-open-in-tab",
      expectedTarget: "tab",
      expectedOption: { background: true },
    },
    {
      preferences: [["browser.tabs.loadInBackground", false]],
      menuItemId: "urlbar-view-context-menu-open-in-tab",
      expectedTarget: "tab",
    },
    {
      preferences: [["browser.tabs.loadInBackground", true]],
      menuItemId: "urlbarView-context-menu-open-in-container-tab-menu",
      expectedTarget: "tab",
      expectedOption: { background: true, userContextId: 1 },
    },
    {
      preferences: [["browser.tabs.loadInBackground", false]],
      menuItemId: "urlbarView-context-menu-open-in-container-tab-menu",
      expectedTarget: "tab",
      expectedOption: { userContextId: 3 },
    },
    {
      menuItemId: "urlbarView-context-menu-open-in-window",
      expectedTarget: "window",
    },
    {
      menuItemId: "urlbarView-context-menu-open-in-private-window",
      expectedTarget: "window",
      expectedOption: { private: true },
    },
  ];

  for (let {
    preferences = [],
    menuItemId,
    expectedTarget,
    expectedOption = {},
  } of TEST_CASES) {
    info(
      `Test for ${JSON.stringify({ preferences, menuItemId, expectedOption })}`
    );

    info("Set preferences");
    await SpecialPowers.pushPrefEnv({ set: preferences });

    let onSuggestionOpen =
      expectedTarget == "tab"
        ? BrowserTestUtils.waitForNewTab(gBrowser, "https://example.com/")
        : BrowserTestUtils.waitForNewWindow({ url: "https://example.com/" });

    let contextMenu = await openContextMenuOnFirstResult();
    let menuItem = contextMenu.querySelector(`#${menuItemId}`);
    Assert.ok(menuItem, `Found the menu item ${menuItemId}`);

    if (expectedOption.userContextId) {
      let subMenuItem = await openContainerSubMenuItem(
        menuItem,
        expectedOption.userContextId
      );
      subMenuItem.click();
    } else {
      menuItem.click();
    }

    let target = await onSuggestionOpen;
    switch (expectedTarget) {
      case "tab": {
        Assert.equal(Cu.getClassName(target, true), "XULElement");
        Assert.equal(target.localName, "tab");
        if (expectedOption.background) {
          Assert.notEqual(target, gBrowser.selectedTab);
        } else {
          await TestUtils.waitForCondition(
            () => target == gBrowser.selectedTab
          );
          Assert.equal(target, gBrowser.selectedTab);
        }

        if (expectedOption.userContextId) {
          Assert.equal(
            target.getAttribute("usercontextid"),
            expectedOption.userContextId
          );
          let openedEvent = Glean.containers.containerTabOpened
            .testGetValue()
            .at(-1);
          Assert.equal(
            openedEvent.extra.source,
            "urlbar_result_context_menu",
            "container_tab_opened reports the urlbar source"
          );
        } else {
          Assert.ok(!target.hasAttribute("usercontextid"));
        }
        BrowserTestUtils.removeTab(target);
        break;
      }
      case "window": {
        Assert.equal(Cu.getClassName(target, true), "Window");
        Assert.equal(
          PrivateBrowsingUtils.isWindowPrivate(target),
          !!expectedOption.private
        );
        target.close();
        break;
      }
    }
  }

  await PlacesUtils.history.clear();
});

add_task(async function toolbar_context_menu() {
  let TEST_TARGETS = [
    ".searchmode-switcher",
    "#trust-icon-container",
    "#identity-box",
  ];

  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    // Make search mode switcher visible.
    document.querySelector(".searchmode-switcher").focus();

    for (let target of TEST_TARGETS) {
      info(`Test for ${target}`);
      let element = document.querySelector(target);
      let onPopupShown = BrowserTestUtils.waitForEvent(document, "popupshown");
      EventUtils.synthesizeMouseAtCenter(element, {
        type: "contextmenu",
        button: 2,
      });
      let { target: popup } = await onPopupShown;
      Assert.equal(popup.id, "toolbar-context-menu");
      popup.hidePopup();
    }
  });
});

add_task(async function no_context_menu() {
  let TEST_DATA = [
    {
      featureGate: false,
      target: ".urlbarView-row",
    },
    {
      featureGate: false,
      target: ".urlbar-background",
    },
    {
      featureGate: true,
      target: ".urlbar-background",
    },
  ];

  for (let { featureGate, target } of TEST_DATA) {
    info(`Test for ${JSON.stringify({ featureGate, target })}`);
    await SpecialPowers.pushPrefEnv({
      set: [["browser.urlbar.contextMenu.featureGate", featureGate]],
    });

    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      value: "exa",
      window,
      fireInputEvent: true,
    });

    let onContextMenu = BrowserTestUtils.waitForEvent(window, "contextmenu");
    let menuShown = false;
    let menuListener = () => {
      menuShown = true;
    };
    window.addEventListener("showing", menuListener, true);

    document.querySelector(target).dispatchEvent(
      new PointerEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        view: window,
      })
    );

    info("Waiting for context menu");
    let event = await onContextMenu;
    Assert.ok(event.defaultPrevented);

    Assert.ok(!menuShown);
    window.removeEventListener("showing", menuListener, true);

    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function keep_view_open_on_context_menu_mousedown() {
  let contextMenu = await openContextMenuOnFirstResult();
  Assert.ok(
    gURLBar.view.isOpen,
    "The view should remain open after the context menu is shown"
  );

  info("Mouse down on a context menu item");
  EventUtils.synthesizeMouseAtCenter(
    contextMenu.querySelector("#urlbar-view-context-menu-open-in-tab"),
    { type: "mousedown" }
  );

  Assert.ok(
    gURLBar.view.isOpen,
    "The view stays open after a mousedown on the context menu"
  );

  contextMenu.hide(undefined, { force: true });
  gURLBar.view.close();
});

async function openContextMenuOnFirstResult() {
  info("Open urlbar results");
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    value: "exa",
    window,
    fireInputEvent: true,
  });
  let { element } = await UrlbarTestUtils.getDetailsOfResultAt(window, 0);

  info("Open context menu");
  let contextMenu = document.getElementById("urlbarView-context-menu");
  let onShown = BrowserTestUtils.waitForEvent(contextMenu, "shown");
  EventUtils.synthesizeMouseAtCenter(element.row, {
    button: 2,
    type: "mousedown",
  });
  EventUtils.synthesizeMouseAtCenter(element.row, {
    button: 2,
    type: "contextmenu",
  });
  await onShown;

  return contextMenu;
}

// Opens the submenu of the given item, the same way hovering it does, and
// returns the submenu panel.
async function openContainerSubMenu(menuItem) {
  let onShown = BrowserTestUtils.waitForEvent(menuItem.submenuPanel, "shown");
  menuItem.dispatchEvent(
    new MouseEvent("mouseenter", { view: menuItem.ownerGlobal })
  );
  await onShown;
  return menuItem.submenuPanel;
}

async function openContainerSubMenuItem(menuItem, userContextId) {
  let subMenu = await openContainerSubMenu(menuItem);
  let subMenuItem = subMenu.querySelector(
    `[data-usercontextid="${userContextId}"]`
  );
  Assert.ok(subMenuItem, `Found the container item for ${userContextId}`);
  await TestUtils.waitForCondition(
    () => subMenuItem.textContent,
    "Waiting for the container item to be labeled"
  );
  return subMenuItem;
}
