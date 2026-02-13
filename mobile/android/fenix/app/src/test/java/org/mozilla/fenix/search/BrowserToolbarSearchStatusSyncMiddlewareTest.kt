/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.search

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.test.runTest
import mozilla.components.compose.browser.toolbar.store.BrowserToolbarAction.EnterEditMode
import mozilla.components.compose.browser.toolbar.store.BrowserToolbarAction.ExitEditMode
import mozilla.components.compose.browser.toolbar.store.BrowserToolbarStore
import mozilla.components.support.test.rule.MainLooperTestRule
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.browser.browsingmode.BrowsingMode
import org.mozilla.fenix.components.AppStore
import org.mozilla.fenix.components.appstate.AppAction.SearchAction.SearchEnded
import org.mozilla.fenix.components.appstate.AppAction.SearchAction.SearchStarted
import org.mozilla.fenix.components.appstate.AppState
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BrowserToolbarSearchStatusSyncMiddlewareTest {

    @get:Rule
    val mainLooperRule = MainLooperTestRule()

    private lateinit var appStore: AppStore

    @Test
    fun `WHEN the toolbar exits search mode THEN synchronize search being ended for the application`() = runTest {
        appStore = AppStore()
        val (_, toolbarStore) = buildMiddlewareAndAddToSearchStore(appStore)
        assertFalse(appStore.state.searchState.isSearchActive)
        assertFalse(toolbarStore.state.isEditMode())

        appStore.dispatch(SearchStarted())
        mainLooperRule.idle()
        assertTrue(appStore.state.searchState.isSearchActive)
        assertTrue(toolbarStore.state.isEditMode())

        toolbarStore.dispatch(ExitEditMode)
        mainLooperRule.idle()
        assertFalse(appStore.state.searchState.isSearchActive)
        assertFalse(toolbarStore.state.isEditMode())
    }

    @Test
    fun `WHEN the toolbar enters search mode THEN don't update the search state for the application`() = runTest {
        appStore = AppStore()
        val (_, toolbarStore) = buildMiddlewareAndAddToSearchStore(appStore)
        assertFalse(toolbarStore.state.isEditMode())
        assertFalse(appStore.state.searchState.isSearchActive)

        toolbarStore.dispatch(EnterEditMode(false))
        mainLooperRule.idle()

        assertFalse(appStore.state.searchState.isSearchActive)
        assertFalse(toolbarStore.state.editState.isQueryPrivate)
    }

    @Test
    fun `GIVEN in private browsing mode WHEN search starts in the application THEN put the toolbar in search mode also`() = runTest {
        appStore = AppStore(AppState(mode = BrowsingMode.Private))
        val (_, toolbarStore) = buildMiddlewareAndAddToSearchStore(appStore)

        appStore.dispatch(SearchStarted())
        mainLooperRule.idle()

        assertTrue(toolbarStore.state.isEditMode())
        assertTrue(toolbarStore.state.editState.isQueryPrivate)
        assertTrue(appStore.state.searchState.isSearchActive)
    }

    @Test
    fun `GIVEN in normal browsing mode WHEN search starts in the application THEN put the toolbar in search mode also`() = runTest {
        appStore = AppStore(AppState(mode = BrowsingMode.Normal))
        val (_, toolbarStore) = buildMiddlewareAndAddToSearchStore(appStore)

        appStore.dispatch(SearchStarted())
        mainLooperRule.idle()

        assertTrue(toolbarStore.state.isEditMode())
        assertFalse(toolbarStore.state.editState.isQueryPrivate)
        assertTrue(appStore.state.searchState.isSearchActive)
    }

    @Test
    fun `WHEN search is closed in the application THEN synchronize exiting edit mode in the toolbar`() = runTest {
        appStore = AppStore()
        val (_, toolbarStore) = buildMiddlewareAndAddToSearchStore(appStore)
        appStore.dispatch(SearchStarted())
        mainLooperRule.idle()
        assertTrue(toolbarStore.state.isEditMode())
        assertTrue(appStore.state.searchState.isSearchActive)

        appStore.dispatch(SearchEnded)
        mainLooperRule.idle()
        assertFalse(appStore.state.searchState.isSearchActive)
        assertFalse(toolbarStore.state.isEditMode())
    }

    private fun buildMiddlewareAndAddToSearchStore(
        appStore: AppStore,
        scope: CoroutineScope = MainScope(),
    ): Pair<BrowserToolbarSearchStatusSyncMiddleware, BrowserToolbarStore> {
        val middleware = buildMiddleware(appStore, scope)
        val toolbarStore = BrowserToolbarStore(
            middleware = listOf(middleware),
        )
        return middleware to toolbarStore
    }

    private fun buildMiddleware(
        appStore: AppStore,
        scope: CoroutineScope = MainScope(),
    ) = BrowserToolbarSearchStatusSyncMiddleware(appStore, scope)
}
