/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.home

import android.view.View
import androidx.navigation.NavController
import io.mockk.MockKAnnotations
import io.mockk.Runs
import io.mockk.every
import io.mockk.impl.annotations.RelaxedMockK
import io.mockk.just
import io.mockk.mockk
import io.mockk.spyk
import io.mockk.verify
import io.mockk.verifyOrder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.StandardTestDispatcher
import mozilla.components.browser.state.state.TabSessionState
import mozilla.components.browser.state.store.BrowserStore
import mozilla.components.feature.tabs.TabsUseCases
import mozilla.components.support.test.robolectric.testContext
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.R
import org.mozilla.fenix.browser.browsingmode.BrowsingMode
import org.mozilla.fenix.components.AppStore
import org.mozilla.fenix.components.Components
import org.mozilla.fenix.components.appstate.AppAction
import org.mozilla.fenix.components.appstate.AppState
import org.mozilla.fenix.components.usecases.FenixBrowserUseCases
import org.mozilla.fenix.ext.components
import org.mozilla.fenix.home.HomeScreenViewModel.Companion.ALL_NORMAL_TABS
import org.mozilla.fenix.home.HomeScreenViewModel.Companion.ALL_PRIVATE_TABS
import org.mozilla.fenix.utils.Settings
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TabsCleanupFeatureTest {

    private val testDispatcher = StandardTestDispatcher()
    private val testCoroutineScope = CoroutineScope(testDispatcher)

    @RelaxedMockK
    private lateinit var viewModel: HomeScreenViewModel

    @RelaxedMockK
    private lateinit var browserStore: BrowserStore

    @RelaxedMockK
    private lateinit var navController: NavController

    @RelaxedMockK
    private lateinit var tabsUseCases: TabsUseCases

    @RelaxedMockK
    private lateinit var fenixBrowserUseCases: FenixBrowserUseCases

    @RelaxedMockK
    private lateinit var settings: Settings

    @RelaxedMockK
    private lateinit var snackBarParentView: View

    @RelaxedMockK
    private lateinit var components: Components

    private lateinit var appStore: AppStore
    private lateinit var feature: TabsCleanupFeature

    @Before
    fun setup() {
        MockKAnnotations.init(this)

        appStore = AppStore(AppState(mode = BrowsingMode.Normal))
        every { components.appStore } returns appStore

        feature = spyk(
            TabsCleanupFeature(
                appStore = appStore,
                context = spyk(testContext) {
                    every { components } returns this@TabsCleanupFeatureTest.components
                },
                viewModel = viewModel,
                browserStore = browserStore,
                navController = navController,
                settings = settings,
                tabsUseCases = tabsUseCases,
                fenixBrowserUseCases = fenixBrowserUseCases,
                snackBarParentView = snackBarParentView,
                viewLifecycleScope = testCoroutineScope,
            ),
        )

        every { feature.showUndoSnackbar(any(), any()) } just Runs
    }

    @Test
    fun `GIVEN all normal tabs to delete WHEN feature is started THEN remove all normal tabs and show undo snackbar`() {
        every { viewModel.sessionToDelete } returns ALL_NORMAL_TABS

        feature.start()

        verify {
            tabsUseCases.removeNormalTabs()

            feature.showUndoSnackbar(
                testContext.getString(R.string.snackbar_tabs_closed),
                any(),
            )

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN all private tabs to delete WHEN feature is started THEN remove all normal tabs and show undo snackbar`() {
        every { viewModel.sessionToDelete } returns ALL_PRIVATE_TABS

        feature.start()

        verify {
            tabsUseCases.removePrivateTabs()

            feature.showUndoSnackbar(
                testContext.getString(R.string.snackbar_private_data_deleted),
                any(),
            )

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN homepage as a new tab is enabled and all normal tabs to delete WHEN feature is started THEN remove all normal tabs and show undo snackbar`() {
        every { settings.enableHomepageAsNewTab } returns true
        every { viewModel.sessionToDelete } returns ALL_NORMAL_TABS

        feature.start()

        verifyOrder {
            tabsUseCases.removeNormalTabs()

            fenixBrowserUseCases.addNewHomepageTab(
                private = appStore.state.mode.isPrivate,
            )

            feature.showUndoSnackbar(
                testContext.getString(R.string.snackbar_tabs_closed),
                any(),
            )

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN homepage as a new tab is enabled and all private tabs to delete WHEN feature is started THEN remove all normal tabs, show undo snackbar and ensure 1 new tab remains`() {
        every { settings.enableHomepageAsNewTab } returns true
        every { viewModel.sessionToDelete } returns ALL_PRIVATE_TABS

        feature.start()

        verifyOrder {
            tabsUseCases.removePrivateTabs()

            fenixBrowserUseCases.addNewHomepageTab(
                private = appStore.state.mode.isPrivate,
            )

            feature.showUndoSnackbar(
                testContext.getString(R.string.snackbar_private_data_deleted),
                any(),
            )

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN all private tabs to delete WHEN remove tabs is called THEN remove all normal tabs and show undo snackbar`() {
        every { viewModel.sessionToDelete } returns ALL_PRIVATE_TABS

        feature.start()

        verify {
            tabsUseCases.removePrivateTabs()

            feature.showUndoSnackbar(
                testContext.getString(R.string.snackbar_private_data_deleted),
                any(),
            )

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN a session ID to delete WHEN feature is started THEN remove tab and show undo snackbar`() {
        val private = true
        val sessionId = "1"

        val tab: TabSessionState = mockk {
            every { content.private } returns private
            every { id } returns sessionId
        }

        every { browserStore.state.tabs } returns listOf(tab)
        every { viewModel.sessionToDelete } returns sessionId

        feature.start()

        verify {
            tabsUseCases.removeTab(sessionId)

            feature.showUndoSnackbar(
                testContext.getString(R.string.snackbar_private_tab_closed),
                any(),
            )

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN homepage as a new tab is enabled and the last tab is to be removed WHEN feature is started THEN remove tab, show undo snackbar and ensure a new tab remains`() {
        val private = true
        val sessionId = "1"
        val tab: TabSessionState = mockk {
            every { content.private } returns private
            every { id } returns sessionId
        }

        every { settings.enableHomepageAsNewTab } returns true
        every { viewModel.sessionToDelete } returns sessionId

        every { browserStore.state.tabs } returns listOf(tab)

        feature.start()

        verifyOrder {
            tabsUseCases.removeTab(sessionId)

            fenixBrowserUseCases.addNewHomepageTab(
                private = appStore.state.mode.isPrivate,
            )

            feature.showUndoSnackbar(
                testContext.getString(R.string.snackbar_private_tab_closed),
                any(),
            )

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN homepage as a new tab is enabled and a session ID to delete WHEN feature is started THEN remove tab and show undo snackbar`() {
        val private = true
        val sessionId = "1"

        val tab: TabSessionState = mockk {
            every { content.private } returns private
            every { id } returns sessionId
        }

        val secondTab: TabSessionState = mockk {
            every { content.private } returns private
            every { id } returns "2"
        }

        every { settings.enableHomepageAsNewTab } returns true
        every { viewModel.sessionToDelete } returns sessionId

        every { browserStore.state.tabs } returns listOf(tab, secondTab)

        appStore.dispatch(AppAction.BrowsingModeManagerModeChanged(mode = BrowsingMode.Private))

        feature.start()

        verify {
            tabsUseCases.removeTab(sessionId)

            feature.showUndoSnackbar(
                testContext.getString(R.string.snackbar_private_tab_closed),
                any(),
            )

            viewModel.sessionToDelete = null
        }

        verify(exactly = 0) {
            fenixBrowserUseCases.addNewHomepageTab(
                private = appStore.state.mode.isPrivate,
            )
        }
    }

    @Test
    fun `WHEN undo all tabs removed is called THEN undo tab removal`() {
        feature.onUndoAllTabsRemoved(tabId = "")

        verify {
            tabsUseCases.undo.invoke()
        }
    }

    @Test
    fun `GIVEN a tab ID WHEN undo all tabs removed is called THEN undo tab removal and remove the tab`() {
        val tabId = "1"

        feature.onUndoAllTabsRemoved(tabId = tabId)

        verifyOrder {
            tabsUseCases.undo.invoke()
            tabsUseCases.removeTab.invoke(tabId)
        }
    }

    @Test
    fun `WHEN undo tab removed is called THEN undo tab removal and navigate to browser`() {
        feature.onUndoTabRemoved(tabId = "")

        verify {
            tabsUseCases.undo.invoke()

            navController.navigate(
                HomeFragmentDirections.actionGlobalBrowser(null),
            )
        }
    }

    @Test
    fun `GIVEN a tab ID WHEN undo tab removed is called THEN undo tab removal, remove the tab and navigate to browser`() {
        val tabId = "1"

        feature.onUndoTabRemoved(tabId = tabId)

        verifyOrder {
            tabsUseCases.undo.invoke()
            tabsUseCases.removeTab.invoke(tabId)
            navController.navigate(
                HomeFragmentDirections.actionGlobalBrowser(null),
            )
        }
    }
}
