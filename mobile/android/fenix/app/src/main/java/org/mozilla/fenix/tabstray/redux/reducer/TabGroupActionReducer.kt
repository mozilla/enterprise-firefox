/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.redux.reducer

import org.mozilla.fenix.tabstray.data.TabsTrayItem
import org.mozilla.fenix.tabstray.navigation.TabManagerNavDestination
import org.mozilla.fenix.tabstray.navigation.TabManagerNavDestination.DeleteTabGroupConfirmationDialog
import org.mozilla.fenix.tabstray.navigation.TabManagerNavDestination.ExpandedTabGroup
import org.mozilla.fenix.tabstray.redux.action.TabGroupAction
import org.mozilla.fenix.tabstray.redux.state.Page
import org.mozilla.fenix.tabstray.redux.state.TabsTrayState
import org.mozilla.fenix.tabstray.redux.state.initializeTabGroupForm

/**
 * Reducer for [TabGroupAction] dispatched from the Tabs Tray store.
 */
object TabGroupActionReducer {

    /**
     * Reduces [TabGroupAction] into a new [TabsTrayState].
     *
     * @param state The current [TabsTrayState].
     * @param action The [TabGroupAction] to reduce.
     */
    fun reduce(
        state: TabsTrayState,
        action: TabGroupAction,
    ): TabsTrayState {
        return when (action) {
            is TabGroupAction.AddToTabGroup -> if (state.tabGroupState.groups.isEmpty()) {
                state.navigateToCreateTabGroup()
            } else {
                state.copy(backStack = state.backStack + TabManagerNavDestination.AddToTabGroup)
            }

            is TabGroupAction.AddToNewTabGroup -> state.navigateToCreateTabGroup()

            is TabGroupAction.DragAndDropTwoTabs -> {
                state.navigateToCreateTabGroup().copy(
                    mode = TabsTrayState.Mode.DragAndDrop(
                        sourceId = action.sourceTabId,
                        destinationId = action.destinationTabId,
                    ),
                )
            }

            is TabGroupAction.NameChanged -> {
                handleNameChange(state = state, action = action)
            }

            is TabGroupAction.ThemeChanged -> {
                handleThemeChange(state = state, action = action)
            }

            is TabGroupAction.SaveClicked -> state.copy(
                mode = TabsTrayState.Mode.Normal,
                backStack = state.backStack.popTabGroupFlow(),
            )

            is TabGroupAction.TabGroupClicked -> processTabGroupClick(
                currentState = state,
                group = action.group,
            )

            is TabGroupAction.TabAddedToGroup -> state

            is TabGroupAction.SelectedTabsAddedToGroup -> state.copy(
                mode = TabsTrayState.Mode.Normal,
                backStack = state.backStack.popTabGroupFlow(),
            )

            is TabGroupAction.DeleteClicked -> state.copy(
                backStack = state.backStack + DeleteTabGroupConfirmationDialog(group = action.group),
            )

            is TabGroupAction.DeleteConfirmed -> state.copy(
                backStack = state.backStack.popDeleteTabGroupFlow(),
            )

            is TabGroupAction.EditTabGroupClicked -> state.copy(
                tabGroupState = state.tabGroupState.copy(
                    formState = action.group.initializeTabGroupForm(),
                ),
                backStack = state.navigateToEditTabGroup(),
            )

            is TabGroupAction.OpenTabGroupClicked -> state.copy(
                selectedPage = Page.NormalTabs,
                backStack = state.backStack + ExpandedTabGroup(group = action.group.copy(closed = false)),
            )

            is TabGroupAction.CloseTabGroupClicked -> state.copy(
                backStack = listOf(TabManagerNavDestination.Root),
            )

            is TabGroupAction.DragAndDropCompleted -> state
        }
    }

    private fun handleThemeChange(state: TabsTrayState, action: TabGroupAction.ThemeChanged): TabsTrayState {
        val form = requireNotNull(state.tabGroupState.formState) {
            "ThemeChanged dispatched with no TabGroupFormState"
        }
        return state.copy(
            tabGroupState = state.tabGroupState.copy(
                formState = form.copy(
                    theme = action.theme,
                    edited = true,
                ),
            ),
        )
    }

    private fun handleNameChange(state: TabsTrayState, action: TabGroupAction.NameChanged): TabsTrayState {
        val form = requireNotNull(state.tabGroupState.formState) {
            "NameChanged dispatched with no TabGroupFormState"
        }
        return state.copy(
            tabGroupState = state.tabGroupState.copy(
                formState = form.copy(
                    name = action.name,
                    edited = true,
                ),
            ),
        )
    }

    private fun TabsTrayState.navigateToCreateTabGroup() = copy(
        tabGroupState = tabGroupState.copy(
            formState = initializeTabGroupForm(),
        ),
        backStack = navigateToEditTabGroup(),
    )

    private fun List<TabManagerNavDestination>.popTabGroupFlow(): List<TabManagerNavDestination> = filterNot {
        it is TabManagerNavDestination.EditTabGroup ||
            it is TabManagerNavDestination.AddToTabGroup
    }

    private fun List<TabManagerNavDestination>.popDeleteTabGroupFlow(): List<TabManagerNavDestination> = filterNot {
        it is DeleteTabGroupConfirmationDialog ||
            it is ExpandedTabGroup
    }

    private fun TabsTrayState.navigateToEditTabGroup(): List<TabManagerNavDestination> =
        backStack + TabManagerNavDestination.EditTabGroup

    private fun processTabGroupClick(
        currentState: TabsTrayState,
        group: TabsTrayItem.TabGroup,
    ): TabsTrayState = when (currentState.mode) {
        is TabsTrayState.Mode.Normal, is TabsTrayState.Mode.DragAndDrop -> currentState.copy(
            backStack = currentState.backStack + ExpandedTabGroup(group = group),
        )

        is TabsTrayState.Mode.Select -> {
            val selectedTabs = currentState.mode.selectedTabs.toHashSet()
            val selectedTabGroups = currentState.mode.selectedTabGroups.toHashSet()

            if (group in currentState.mode.selectedTabGroups) {
                selectedTabGroups.remove(group)
                selectedTabs.removeAll(group.tabs.toSet())
            } else {
                selectedTabGroups.add(group)
                selectedTabs.addAll(group.tabs)
            }

            val newMode = if (selectedTabs.isEmpty() && selectedTabGroups.isEmpty()) {
                TabsTrayState.Mode.Normal
            } else {
                TabsTrayState.Mode.Select(
                    selectedTabs = selectedTabs,
                    selectedTabGroups = selectedTabGroups,
                )
            }

            currentState.copy(mode = newMode)
        }
    }
}
