/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.home.ui

import androidx.navigation.NavController
import mozilla.components.concept.engine.utils.ABOUT_HOME_URL
import org.mozilla.fenix.HomeActivity
import org.mozilla.fenix.R
import org.mozilla.fenix.browser.ToolbarGestureHandler
import org.mozilla.fenix.components.Components
import org.mozilla.fenix.databinding.FragmentHomeBinding
import org.mozilla.fenix.home.toolbar.FenixHomeToolbar
import org.mozilla.fenix.home.toolbar.HomeNavigationBar
import org.mozilla.fenix.utils.Settings

/**
 * Adds swipe-to-switch-tabs support to the Home UI.
 *
 * When "Homepage as a tab" is enabled, Home represents a special tab
 * (`about:home`). Swiping on the Home toolbar should allow switching
 * to adjacent tabs. If the swipe selects a non-home tab, this class
 * navigates from HomeFragment to BrowserFragment so the selected tab’s
 * content becomes visible.
 */
@Suppress("LongParameterList")
class HomeSwipeIntegration(
    private val components: Components,
    private val settings: Settings,
    private val binding: FragmentHomeBinding,
    private val activity: HomeActivity,
    private val toolbarView: FenixHomeToolbar,
    private val homeNavigationBar: HomeNavigationBar?,
    private val navController: NavController,
) {

    /**
     * Initializes toolbar swipe gestures on Home when enabled in settings.
     */
    fun initializeSwipeUI() {
        if (!settings.isTabStripEnabled && settings.isSwipeToolbarToSwitchTabsEnabled &&
            settings.enableHomepageAsNewTab
        ) {
            binding.gestureLayout.addGestureListener(
                ToolbarGestureHandler(
                    activity = activity,
                    contentLayout = binding.homeLayout,
                    tabPreview = binding.tabPreview,
                    toolbarLayout = toolbarView.layout,
                    navBarLayout = homeNavigationBar?.layout,
                    store = components.core.store,
                    selectTabUseCase = components.useCases.tabsUseCases.selectTab,
                    onSwipeStarted = {
                    },
                    onTabSwitched = { tab ->
                        if (tab.content.url != ABOUT_HOME_URL &&
                            navController.currentDestination?.id == R.id.homeFragment
                        ) {
                            navController.navigate(R.id.browserFragment)
                        }
                    },
                ),
            )
        }
    }
}
