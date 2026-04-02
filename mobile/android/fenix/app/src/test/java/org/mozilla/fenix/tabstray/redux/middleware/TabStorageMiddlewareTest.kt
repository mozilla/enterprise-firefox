/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.redux.middleware

import androidx.test.ext.junit.runners.AndroidJUnit4
import junit.framework.TestCase.assertEquals
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import mozilla.components.browser.state.state.createTab
import mozilla.components.support.utils.DateTimeProvider
import mozilla.components.support.utils.FakeDateTimeProvider
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.tabgroups.fakes.FakeTabGroupRepository
import org.mozilla.fenix.tabgroups.storage.database.StoredTabGroup
import org.mozilla.fenix.tabgroups.storage.repository.TabGroupRepository
import org.mozilla.fenix.tabstray.data.TabData
import org.mozilla.fenix.tabstray.data.TabGroupTheme
import org.mozilla.fenix.tabstray.data.TabsTrayItem
import org.mozilla.fenix.tabstray.redux.action.TabGroupAction
import org.mozilla.fenix.tabstray.redux.state.TabGroupFormState
import org.mozilla.fenix.tabstray.redux.state.TabsTrayState
import org.mozilla.fenix.tabstray.redux.store.TabsTrayStore
import org.mozilla.fenix.tabstray.data.createTab as createTabsTrayItemTab

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class TabStorageMiddlewareTest {

    private val fakeDateTimeProvider = FakeDateTimeProvider(currentTime = 10L)

    @Test
    fun `WHEN the selected tab ID is updated THEN transform the data and dispatch an update`() = runTest {
        val expectedTabId = "1"
        val initialState = TabData(
            selectedTabId = null,
            tabs = listOf(createTab(id = expectedTabId, url = "")),
        )
        val expectedState = TabsTrayState(
            selectedTabId = expectedTabId,
            normalTabs = listOf(TabsTrayItem.Tab(createTab(id = expectedTabId, url = ""))),
        )
        val tabFlow = MutableStateFlow(initialState)
        val store = createStore(
            tabDataFlow = tabFlow,
            scope = backgroundScope,
        )

        tabFlow.emit(initialState.copy(selectedTabId = expectedTabId))

        runCurrent()
        advanceUntilIdle()

        assertEquals(expectedState, store.state)
    }

    @Test
    fun `WHEN normal tabs has updated THEN transform the data and dispatch an update`() = runTest {
        val expectedTab = createTab("test1")
        val initialState = TabData()
        val expectedState = TabsTrayState(
            selectedTabId = expectedTab.id,
            normalTabs = listOf(TabsTrayItem.Tab(expectedTab)),
        )
        val tabFlow = MutableStateFlow(initialState)
        val store = createStore(
            tabDataFlow = tabFlow,
            scope = backgroundScope,
        )

        tabFlow.emit(initialState.copy(selectedTabId = expectedTab.id, tabs = initialState.tabs + expectedTab))

        runCurrent()
        advanceUntilIdle()

        assertEquals(expectedState, store.state)
    }

    @Test
    fun `WHEN inactive tabs has updated THEN transform the data and dispatch an update`() =
        runTest {
            val expectedTab = createTab("test1", lastAccess = 0L, createdAt = 0L)
            val initialState = TabData()
            val expectedState = TabsTrayState(
                selectedTabId = expectedTab.id,
                inactiveTabs = TabsTrayState.InactiveTabsState(
                    tabs = listOf(
                        TabsTrayItem.Tab(
                            expectedTab,
                        ),
                    ),
                ),
            )
            val tabFlow = MutableStateFlow(initialState)
            val store = createStore(
                inactiveTabsEnabled = true,
                tabDataFlow = tabFlow,
                scope = backgroundScope,
            )

        tabFlow.emit(initialState.copy(selectedTabId = expectedTab.id, tabs = initialState.tabs + expectedTab))

        runCurrent()
        advanceUntilIdle()

        assertEquals(expectedState, store.state)
    }

    @Test
    fun `WHEN private tabs has updated THEN transform the data and dispatch an update`() = runTest {
        val expectedTab = createTab("test1", private = true)
        val initialState = TabData()
        val expectedState = TabsTrayState(
            selectedTabId = expectedTab.id,
            privateBrowsing = TabsTrayState.PrivateBrowsingState(
                tabs = listOf(TabsTrayItem.Tab(expectedTab)),
            ),
        )
        val tabFlow = MutableStateFlow(initialState)
        val store = createStore(
            tabDataFlow = tabFlow,
            scope = backgroundScope,
        )

        tabFlow.emit(initialState.copy(selectedTabId = expectedTab.id, tabs = initialState.tabs + expectedTab))

        runCurrent()
        advanceUntilIdle()

        assertEquals(expectedState, store.state)
    }

    @Test
    fun `WHEN tab groups have updated THEN transform the data and dispatch an update`() = runTest {
        val expectedTab = createTab("test1")
        val expectedDisplayTab = TabsTrayItem.Tab(expectedTab)
        val initialState = TabData(
            tabs = listOf(expectedTab),
        )
        val tabGroup = StoredTabGroup(
            title = "title",
            theme = "Red",
            lastModified = 0L,
        )
        val expectedTabGroup = TabsTrayItem.TabGroup(
            id = tabGroup.id,
            title = tabGroup.title,
            theme = TabGroupTheme.valueOf(tabGroup.theme),
            tabs = mutableListOf(expectedDisplayTab),
        )
        val expectedState = TabsTrayState(
            normalTabs = listOf(expectedTabGroup),
            tabGroups = listOf(expectedTabGroup),
            config = TabsTrayState.TabsTrayConfig(tabGroupsEnabled = false),
        )
        val tabFlow = MutableStateFlow(initialState)
        val tabGroupFlow = MutableStateFlow(emptyList<StoredTabGroup>())
        val tabGroupAssignmentFlow = MutableStateFlow(emptyMap<String, String>())
        val store = createStore(
            tabGroupsEnabled = true,
            tabDataFlow = tabFlow,
            tabGroupRepository = createRepository(
                tabGroupFlow = tabGroupFlow,
                tabGroupAssignmentFlow = tabGroupAssignmentFlow,
            ),
            scope = backgroundScope,
        )

        tabGroupFlow.emit(listOf(tabGroup))
        tabGroupAssignmentFlow.emit(mapOf(expectedTab.id to tabGroup.id))

        runCurrent()
        advanceUntilIdle()

        assertEquals(expectedState, store.state)
    }

    @Test
    fun `GIVEN the theme from the database is valid WHEN transforming tab group data THEN return the mapped tab group theme`() {
        val expectedTabGroupTheme = TabGroupTheme.Blue
        val middleware = TabStorageMiddleware(
            inactiveTabsEnabled = false,
            tabGroupsEnabled = true,
            tabDataFlow = flowOf(),
            tabGroupRepository = createRepository(),
        )
        val actualTheme = with(middleware) {
            expectedTabGroupTheme.name.toTabGroupTheme()
        }

        assertEquals(expectedTabGroupTheme, actualTheme)
    }

    @Test
    fun `GIVEN the theme from the database is invalid WHEN transforming tab group data THEN return the default tab group theme`() {
        val expectedTabGroupTheme = TabGroupTheme.default
        val middleware = TabStorageMiddleware(
            inactiveTabsEnabled = false,
            tabGroupsEnabled = true,
            tabDataFlow = flowOf(),
            tabGroupRepository = createRepository(),
        )
        val actualTheme = with(middleware) {
            "Rainbow123".toTabGroupTheme()
        }

        assertEquals(expectedTabGroupTheme, actualTheme)
    }

    @Test
    fun `WHEN save is clicked in multiselect mode for a new group THEN create the group with selected tabs`() = runTest {
        val testFlow = MutableStateFlow(emptyList<StoredTabGroup>())
        val repository = createRepository(testFlow)
        val selectedTabs = setOf(
            createTabsTrayItemTab("https://mozilla.org"),
            createTabsTrayItemTab("https://example.com"),
        )
        val expectedTitle = "Group 1"
        val expectedTheme = TabGroupTheme.Red
        val store = createStore(
            initialState = TabsTrayState(
                mode = TabsTrayState.Mode.Select(selectedTabs = selectedTabs),
                tabGroupFormState = TabGroupFormState(
                    name = expectedTitle,
                    tabGroupId = null,
                    theme = expectedTheme,
                ),
            ),
            tabGroupRepository = repository,
            dateTimeProvider = fakeDateTimeProvider,
            scope = backgroundScope,
        )

        assertTrue(repository.fetchTabGroups().isEmpty())
        assertTrue(repository.fetchTabGroupAssignments().isEmpty())

        store.dispatch(TabGroupAction.SaveClicked)

        runCurrent()
        advanceUntilIdle()

        assertEquals(1, repository.fetchTabGroups().size)
        val storedGroup = repository.fetchTabGroups().first()
        assertEquals(
            StoredTabGroup(
                id = storedGroup.id,
                title = expectedTitle,
                theme = expectedTheme.name,
                lastModified = fakeDateTimeProvider.currentTimeMillis(),
            ),
            storedGroup,
        )
        assertEquals(
            selectedTabs.associate { it.id to storedGroup.id },
            repository.fetchTabGroupAssignments(),
        )
    }

    @Test
    fun `WHEN save is clicked with no existing tab group id or selected tabs THEN add new tab group`() = runTest {
        val testFlow = MutableStateFlow(emptyList<StoredTabGroup>())
        val repository = createRepository(testFlow)
        val expectedTitle = "Group 1"
        val expectedTheme = TabGroupTheme.Red
        val store = createStore(
            initialState = TabsTrayState(
                tabGroupFormState = TabGroupFormState(
                    name = expectedTitle,
                    tabGroupId = null,
                    theme = expectedTheme,
                ),
            ),
            tabGroupRepository = repository,
            dateTimeProvider = fakeDateTimeProvider,
            scope = backgroundScope,
        )

        assertTrue(repository.fetchTabGroups().isEmpty())
        assertTrue(repository.fetchTabGroupAssignments().isEmpty())

        store.dispatch(TabGroupAction.SaveClicked)

        runCurrent()
        advanceUntilIdle()

        assertEquals(1, repository.fetchTabGroups().size)
        val storedGroup = repository.fetchTabGroups().first()
        assertEquals(
            StoredTabGroup(
                id = storedGroup.id,
                title = expectedTitle,
                theme = expectedTheme.name,
                lastModified = fakeDateTimeProvider.currentTimeMillis(),
            ),
            storedGroup,
        )
        assertTrue(repository.fetchTabGroupAssignments().isEmpty())
    }

    @Test
    fun `WHEN save is clicked with existing tab group id THEN update existing tab group`() = runTest {
        val existingId = "1"
        val expectedTitle = "New name"
        val expectedTheme = TabGroupTheme.Blue
        val existingGroup = StoredTabGroup(
            id = existingId,
            title = "Old name",
            theme = TabGroupTheme.Red.name,
            lastModified = 0L,
        )
        val testFlow = MutableStateFlow(listOf(existingGroup))
        val repository = createRepository(testFlow)
        val store = createStore(
            initialState = TabsTrayState(
                tabGroupFormState = TabGroupFormState(
                    tabGroupId = existingId,
                    name = expectedTitle,
                    theme = expectedTheme,
                ),
            ),
            tabGroupRepository = repository,
            dateTimeProvider = fakeDateTimeProvider,
            scope = backgroundScope,
        )

        assertEquals(listOf(existingGroup), repository.fetchTabGroups())

        store.dispatch(TabGroupAction.SaveClicked)

        runCurrent()
        advanceUntilIdle()

        assertEquals(
            listOf(
                StoredTabGroup(
                    id = existingId,
                    title = expectedTitle,
                    theme = expectedTheme.name,
                    lastModified = fakeDateTimeProvider.currentTimeMillis(),
                ),
            ),
            repository.fetchTabGroups(),
        )
        assertTrue(repository.fetchTabGroupAssignments().isEmpty())
    }

    @Test
    fun `WHEN save is clicked with no form state THEN no tab group writes occur`() = runTest {
        val repository = createRepository()
        val store = createStore(
            initialState = TabsTrayState(),
            tabGroupRepository = repository,
            scope = backgroundScope,
        )

        store.dispatch(TabGroupAction.SaveClicked)

        runCurrent()
        advanceUntilIdle()

        assertTrue(repository.fetchTabGroups().isEmpty())
        assertTrue(repository.fetchTabGroupAssignments().isEmpty())
    }

    @Test
    fun `Given the tab groups feature is disabled WHEN initializing THEN the tab group data is not emitted`() = runTest {
        val expectedTab = createTab("test1")
        val initialState = TabData(
            tabs = listOf(expectedTab),
        )
        val expectedTabGroup = StoredTabGroup(
            title = "title",
            theme = "Red",
            lastModified = 0L,
        )
        val expectedState = TabsTrayState(
            normalTabs = listOf(TabsTrayItem.Tab(expectedTab)),
        )
        val tabFlow = MutableStateFlow(initialState)
        val tabGroupFlow = MutableStateFlow(listOf(expectedTabGroup))
        val tabGroupAssignmentFlow = MutableStateFlow(mapOf(expectedTab.id to expectedTabGroup.id))
        val store = createStore(
            tabGroupsEnabled = false,
            tabDataFlow = tabFlow,
            tabGroupRepository = createRepository(
                tabGroupFlow = tabGroupFlow,
                tabGroupAssignmentFlow = tabGroupAssignmentFlow,
            ),
            scope = backgroundScope,
        )

        runCurrent()
        advanceUntilIdle()

        assertEquals(expectedState, store.state)
    }

    private fun createStore(
        initialState: TabsTrayState = TabsTrayState(),
        inactiveTabsEnabled: Boolean = false,
        tabGroupsEnabled: Boolean = false,
        tabDataFlow: Flow<TabData> = flowOf(),
        tabGroupRepository: TabGroupRepository = createRepository(),
        dateTimeProvider: DateTimeProvider = fakeDateTimeProvider,
        scope: CoroutineScope,
    ) = TabsTrayStore(
        initialState = initialState,
        middlewares = listOf(
            TabStorageMiddleware(
                inactiveTabsEnabled = inactiveTabsEnabled,
                tabGroupsEnabled = tabGroupsEnabled,
                tabDataFlow = tabDataFlow,
                tabGroupRepository = tabGroupRepository,
                dateTimeProvider = dateTimeProvider,
                scope = scope,
                mainScope = scope,
            ),
        ),
    )

    private fun createRepository(
        tabGroupFlow: MutableStateFlow<List<StoredTabGroup>> = MutableStateFlow(emptyList()),
        tabGroupAssignmentFlow: MutableStateFlow<Map<String, String>> = MutableStateFlow(mapOf()),
    ) = FakeTabGroupRepository(
        tabGroupFlow = tabGroupFlow,
        tabGroupAssignmentFlow = tabGroupAssignmentFlow,
    )
}
