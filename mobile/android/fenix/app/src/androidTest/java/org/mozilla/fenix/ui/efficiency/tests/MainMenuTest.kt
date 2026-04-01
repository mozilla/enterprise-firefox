/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.ui.efficiency.tests

import org.junit.Test
import org.mozilla.fenix.customannotations.SmokeTest
import org.mozilla.fenix.ui.efficiency.helpers.BaseTest

class MainMenuTest : BaseTest() {

    // TestRail link: https://mozilla.testrail.io/index.php?/cases/view/3080168
    @SmokeTest
    @Test
    fun verifyMainMenuItemsTest() {
        on.mainMenu.navigateToPage()
            .mozVerifyElementsByGroup("homeBanner")
    }

    // TestRail link: https://mozilla.testrail.io/index.php?/cases/view/3080172
    @SmokeTest
    @Test
    fun verifyTheExtensionsMenuOptionTest() {
        on.settingsAddonsManager.navigateToPage()
            .mozVerifyElementsByGroup("addOns")
        on.home.navigateToPage()
    }

    // TestRail link: https://mozilla.testrail.io/index.php?/cases/view/3080181
    @SmokeTest
    @Test
    fun verifyTheHomePageSettingsMenuItemTest() {
        on.settings.navigateToPage()
        on.home.navigateToPage()
    }
}
