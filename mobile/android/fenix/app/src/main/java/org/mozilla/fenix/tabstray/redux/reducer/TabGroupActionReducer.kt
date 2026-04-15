/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.redux.reducer

import org.mozilla.fenix.tabstray.redux.action.TabGroupAction
import org.mozilla.fenix.tabstray.redux.state.TabsTrayState

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
            is TabGroupAction.NameChanged -> {
                val form = requireNotNull(state.tabGroupFormState) {
                    "NameChanged dispatched with no TabGroupFormState"
                }
                state.copy(
                    tabGroupFormState = form.copy(
                        name = action.name,
                        edited = true,
                    ),
                )
            }

            TabGroupAction.FormDismissed,
            TabGroupAction.SaveClicked,
                 -> state.copy(tabGroupFormState = null)
        }
    }
}
