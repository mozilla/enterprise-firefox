"use strict";

var overflowPanel, originalWindowWidth;

add_setup(function () {
  overflowPanel = document.getElementById("widget-overflow");
  originalWindowWidth = ensureToolbarOverflow(window);
});

registerCleanupFunction(function () {
  overflowPanel.removeAttribute("animate");
  window.resizeTo(originalWindowWidth, window.outerHeight);
  let navbar = document.getElementById(CustomizableUI.AREA_NAVBAR);
  return TestUtils.waitForCondition(() => !navbar.hasAttribute("overflowing"));
});

// Right-click on an item within the overflow panel should
// show a context menu with options to move it.
add_task(async function () {
  overflowPanel.setAttribute("animate", "false");

  const buttonId = AppConstants.MOZ_ENTERPRISE
    ? "email-link-button"
    : "fxa-toolbar-menu-button";
  let button = document.getElementById(buttonId);

  if (BrowserTestUtils.isHidden(button)) {
    // Button is likely hidden since the user is logged out.
    let initialFxaStatus = document.documentElement.getAttribute("fxastatus");
    document.documentElement.setAttribute("fxastatus", "signed_in");
    registerCleanupFunction(() =>
      document.documentElement.setAttribute("fxastatus", initialFxaStatus)
    );
    ok(BrowserTestUtils.isVisible(button), "Button is now visible");
  }

  let navbar = document.getElementById(CustomizableUI.AREA_NAVBAR);
  ok(
    !navbar.hasAttribute("overflowing"),
    "Should start with a non-overflowing toolbar."
  );
  window.resizeTo(kForceOverflowWidthPx, window.outerHeight);

  await TestUtils.waitForCondition(() => navbar.hasAttribute("overflowing"));
  ok(navbar.hasAttribute("overflowing"), "Should have an overflowing toolbar.");

  let chevron = document.getElementById("nav-bar-overflow-button");
  let shownPanelPromise = promisePanelElementShown(window, overflowPanel);
  chevron.click();
  await shownPanelPromise;

  let contextMenu = document.getElementById(
    "customizationPanelItemContextMenu"
  );
  let shownContextPromise = popupShown(contextMenu);
  ok(button, buttonId + " was found");
  await TestUtils.waitForCondition(
    () => button.getAttribute("overflowedItem") == "true",
    buttonId + " should be overflowing"
  );
  EventUtils.synthesizeMouse(button, 2, 2, {
    type: "contextmenu",
    button: 2,
  });
  await shownContextPromise;

  is(
    overflowPanel.state,
    "open",
    "The widget overflow panel should still be open."
  );

  let expectedEntries = [
    [".customize-context-moveToPanel", true],
    [".customize-context-removeFromPanel", true],
    ["---"],
    [".viewCustomizeToolbar", true],
  ];
  checkContextMenu(contextMenu, expectedEntries);

  let hiddenContextPromise = popupHidden(contextMenu);
  let hiddenPromise = promisePanelElementHidden(window, overflowPanel);
  let moveToPanel = contextMenu.querySelector(".customize-context-moveToPanel");
  if (moveToPanel) {
    contextMenu.activateItem(moveToPanel);
  } else {
    contextMenu.hidePopup();
  }
  await hiddenContextPromise;
  await hiddenPromise;

  let buttonPlacement = CustomizableUI.getPlacementOfWidget(buttonId);
  ok(buttonPlacement, "Button should still have a placement");
  is(
    buttonPlacement && buttonPlacement.area,
    CustomizableUI.AREA_FIXED_OVERFLOW_PANEL,
    "Button should be pinned now"
  );
  CustomizableUI.reset();
  ensureToolbarOverflow(window, false);

  // In some cases, it can take a tick for the navbar to overflow again. Wait for it:
  await TestUtils.waitForCondition(() => button.hasAttribute("overflowedItem"));
  ok(navbar.hasAttribute("overflowing"), "Should have an overflowing toolbar.");

  buttonPlacement = CustomizableUI.getPlacementOfWidget(buttonId);
  ok(buttonPlacement, "Button should still have a placement");
  is(
    buttonPlacement && buttonPlacement.area,
    "nav-bar",
    "Button should be back in the navbar now"
  );

  is(
    button.getAttribute("overflowedItem"),
    "true",
    "Button should still be overflowed"
  );
});
