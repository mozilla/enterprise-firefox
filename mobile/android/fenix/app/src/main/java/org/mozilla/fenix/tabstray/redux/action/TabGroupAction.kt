/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.redux.action

/**
 *[TabsTrayAction]'s that represent user interactions for the Tab Group feature.
 */
sealed interface TabGroupAction : TabsTrayAction {

    /**
     * Fired when the user changes the tab group name.
     *
     * @property name The name of the tab group the user has typed in.
     */
    data class NameChanged(val name: String) : TabGroupAction

    /**
     * Confirms the save of a tab group.
     */
    data object SaveClicked : TabGroupAction

    /**
     * Invoked when the user dismisses the tab group form.
     */
    data object FormDismissed : TabGroupAction
}
