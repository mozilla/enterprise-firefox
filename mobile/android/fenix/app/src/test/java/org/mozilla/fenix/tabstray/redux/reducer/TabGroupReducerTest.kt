/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.redux.reducer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
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
}
