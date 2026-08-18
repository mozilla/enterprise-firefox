/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const PREF_RECOMMENDATIONS_ENABLED =
  "extensions.htmlaboutaddons.recommendations.enabled";

// The mochitest profile re-enables both prefs on the user branch; clear those
// overrides to get the defaults enterprise builds ship.
add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    clear: [[PREF_DISCOVER_ENABLED], [PREF_RECOMMENDATIONS_ENABLED]],
  });
});

add_task(async function testNoRecommendationsCategory() {
  await SpecialPowers.pushPrefEnv({ clear: [[PREF_UI_LASTCATEGORY]] });

  let win = await open_manager(null);
  ok(
    !AboutAddonsTestUtils.isCategoryVisible(win, "discover"),
    "The Recommendations category is hidden"
  );

  await wait_for_view_load(win);
  is(
    AboutAddonsTestUtils.getSidebarSelectedCategory(win),
    "extension",
    "about:addons opens on the extension list instead"
  );

  await close_manager(win);
  await SpecialPowers.popPrefEnv();
});

add_task(async function testNoRecommendationsInListViews() {
  for (let type of ["extension", "theme"]) {
    let win = await loadInitialView(type);
    ok(
      !win.document.querySelector("recommended-addon-list"),
      `There are no recommendations in the ${type} list view`
    );
    await closeView(win);
  }
});
