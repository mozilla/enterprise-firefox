/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.ui.efficiency.pageObjects

import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import org.mozilla.fenix.helpers.HomeActivityIntentTestRule
import org.mozilla.fenix.ui.efficiency.helpers.BasePage
import org.mozilla.fenix.ui.efficiency.helpers.Selector
import org.mozilla.fenix.ui.efficiency.navigation.NavigationRegistry
import org.mozilla.fenix.ui.efficiency.navigation.NavigationStep
import org.mozilla.fenix.ui.efficiency.selectors.TabDrawerSelectors
import org.mozilla.fenix.ui.efficiency.selectors.ToolbarSelectors

class TabDrawerPage(composeRule: AndroidComposeTestRule<HomeActivityIntentTestRule, *>) : BasePage(composeRule) {
    override val pageName = "TabDrawerPage"

    init {
        NavigationRegistry.register(
            from = "HomePage",
            to = pageName,
            steps = listOf(
                NavigationStep.Click(ToolbarSelectors.TAB_COUNTER),
            ),
        )

        NavigationRegistry.register(
            from = pageName,
            to = "HomePage",
            steps = listOf(NavigationStep.PressBack),
        )

        NavigationRegistry.register(
            from = pageName,
            to = "BrowserPage",
            steps = listOf(NavigationStep.PressBack),
        )
    }

    override fun mozGetSelectorsByGroup(group: String): List<Selector> {
        return TabDrawerSelectors.all.filter { it.groups.contains(group) }
    }

    fun closeTabWithTitle(title: String): TabDrawerPage {
        mozClickFirstWithParentText(TabDrawerSelectors.TAB_ITEM_CLOSE, title)
        return this
    }

    fun verifyNormalTabsList(): TabDrawerPage {
        mozWaitUntilAbsent(TabDrawerSelectors.EMPTY_NORMAL_TABS_LIST)
        mozVerify(TabDrawerSelectors.NORMAL_TABS_LIST)
        return this
    }

    fun verifyExistingOpenTabs(vararg urls: String): TabDrawerPage {
        urls.forEach { url ->
            mozVerifyAnyHasChildWithText(TabDrawerSelectors.TAB_ITEM_ROOT, url)
        }
        return this
    }
}
