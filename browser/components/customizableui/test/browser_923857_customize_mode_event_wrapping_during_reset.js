/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Customize mode reset button should revert correctly
add_task(async function () {
  await startCustomizing();
  let devButton = document.getElementById("developer-button");
  let buttonId = AppConstants.MOZ_ENTERPRISE
    ? "enterprise-badge-toolbar-button"
    : "fxa-toolbar-menu-button";
  let button = document.getElementById(buttonId);
  let stopReloadButton = document.getElementById("stop-reload-button");
  let palette = document.getElementById("customization-palette");
  ok(devButton && button && stopReloadButton && palette, "Stuff should exist");
  simulateItemDrag(devButton, button);
  simulateItemDrag(stopReloadButton, palette);
  await gCustomizeMode.reset();
  ok(CustomizableUI.inDefaultState, "Should be back in default state");
  await endCustomizing();
});

add_task(async function asyncCleanup() {
  await resetCustomization();
});
