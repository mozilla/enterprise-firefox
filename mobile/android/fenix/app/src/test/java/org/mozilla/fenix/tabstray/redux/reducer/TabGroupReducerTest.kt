/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.redux.reducer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.mozilla.fenix.tabstray.data.TabGroupTheme
import org.mozilla.fenix.tabstray.data.createTabGroup
import org.mozilla.fenix.tabstray.navigation.TabManagerNavDestination.AddToTabGroup
import org.mozilla.fenix.tabstray.navigation.TabManagerNavDestination.CreateTabGroup
import org.mozilla.fenix.tabstray.navigation.TabManagerNavDestination.ExpandedTabGroup
import org.mozilla.fenix.tabstray.redux.action.TabGroupAction
import org.mozilla.fenix.tabstray.redux.state.TabGroupFormState
import org.mozilla.fenix.tabstray.redux.state.TabsTrayState

class TabGroupReducerTest {
    @Test
    fun `WHEN NameChanged AND form state exists THEN name is updated and edited is true`() {
        val initialState = TabsTrayState(
            tabGroupFormState = TabGroupFormState(
                tabGroupId = "1",
                name = "Previous name",
                edited = false,
            ),
        )

        val newName = "New name"

        val resultState = TabGroupActionReducer.reduce(
            initialState,
            TabGroupAction.NameChanged(newName),
        )

        val initialStateForm = requireNotNull(initialState.tabGroupFormState)
        val expectedState = initialState.copy(
            tabGroupFormState = initialStateForm.copy(
                name = newName,
                edited = true,
            ),
        )

        assertEquals(expectedState, resultState)
    }

    @Test
    fun `WHEN SaveClicked THEN form state is set to null`() {
        val initialState = TabsTrayState(
            tabGroupFormState = TabGroupFormState(
                tabGroupId = "1",
                name = "Tab Group 1",
                edited = true,
            ),
        )

        val resultState = TabGroupActionReducer.reduce(initialState, TabGroupAction.SaveClicked)

        assertNull(resultState.tabGroupFormState)
    }

    @Test
    fun `WHEN FormDismissed THEN form state is set to null`() {
        val initialState = TabsTrayState(
            tabGroupFormState = TabGroupFormState(
                tabGroupId = "1",
                name = "Tab Group 1",
                edited = true,
            ),
        )

        val resultState = TabGroupActionReducer.reduce(initialState, TabGroupAction.FormDismissed)

        assertNull(resultState.tabGroupFormState)
    }

    @Test
    fun `GIVEN the user is not in multiselect mode WHEN a tab group is clicked THEN navigate to the expanded tab group destination`() {
        val initialState = TabsTrayState(mode = TabsTrayState.Mode.Normal)
        val expectedTabGroup = createTabGroup()
        val expectedBackStack = initialState.backStack + ExpandedTabGroup(group = expectedTabGroup)
        val resultState = TabGroupActionReducer.reduce(
            state = initialState,
            action = TabGroupAction.TabGroupClicked(group = expectedTabGroup),
        )

        assertEquals(expectedBackStack, resultState.backStack)
    }

    @Test
    fun `GIVEN the user is in multiselect mode WHEN a tab group is clicked THEN do not navigate away`() {
        val initialState = TabsTrayState(mode = TabsTrayState.Mode.Select(selectedTabs = setOf()))
        val expectedTabGroup = createTabGroup()
        val expectedBackStack = initialState.backStack
        val resultState = TabGroupActionReducer.reduce(
            state = initialState,
            action = TabGroupAction.TabGroupClicked(group = expectedTabGroup),
        )

        assertEquals(expectedBackStack, resultState.backStack)
    }

    @Test
    fun `WHEN add to tab group is clicked THEN navigate to add to tab group destination`() {
        val initialState = TabsTrayState()

        val expectedBackStack = initialState.backStack + AddToTabGroup

        val resultState = TabGroupActionReducer.reduce(
            state = initialState,
            action = TabGroupAction.AddToTabGroup,
        )

        assertEquals(expectedBackStack, resultState.backStack)
    }

    @Test
    fun `WHEN add to new tab group is clicked THEN navigate to create tab group destination`() {
        val initialState = TabsTrayState()

        val expectedFormState = TabGroupFormState(
            tabGroupId = null,
            name = "",
            nextTabGroupNumber = initialState.tabGroups.size + 1,
            edited = false,
        )
        val expectedBackStack = initialState.backStack + CreateTabGroup

        val resultState = TabGroupActionReducer.reduce(
            state = initialState,
            action = TabGroupAction.AddToNewTabGroup,
        )

        assertEquals(expectedFormState, resultState.tabGroupFormState)
        assertEquals(expectedBackStack, resultState.backStack)
    }

    @Test
    fun `WHEN ThemeChanged is called THEN theme is updated`() {
        val initialFormState = TabGroupFormState(tabGroupId = "123", name = "123", theme = TabGroupTheme.Blue)

        val resultState = TabGroupActionReducer.reduce(
            TabsTrayState(tabGroupFormState = initialFormState),
            TabGroupAction.ThemeChanged(theme = TabGroupTheme.Pink),
        )

        assertEquals(resultState.tabGroupFormState!!.theme, TabGroupTheme.Pink)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `WHEN ThemeChanged is called with null form THEN exception is thrown`() {
        val resultState = TabGroupActionReducer.reduce(
            TabsTrayState(tabGroupFormState = null),
            TabGroupAction.ThemeChanged(theme = TabGroupTheme.Pink),
        )

        assertEquals(resultState.tabGroupFormState!!.theme, TabGroupTheme.Pink)
    }
}
