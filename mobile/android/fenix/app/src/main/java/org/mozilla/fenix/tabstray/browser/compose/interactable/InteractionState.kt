/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.browser.compose.interactable

import androidx.compose.foundation.lazy.grid.LazyGridItemInfo
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.ui.geometry.Offset

/**
 * Defines the state for an interactable grid or list item.
 */
sealed interface InteractionState {
    /**
     * The item's index in the list of interactable items.
     */
    val index: Int?

    /**
     * The item's unique key, typically a String.
     */
    val key: String?

    /**
     * Represents the point in grid space when the item was first interacted with
     */
    val initialOffset: Offset

    /**
     * Represents the current point in grid space.  A dragged item's cumulated offset is updated as the drag continues.
     */
    val cumulatedOffset: Offset

    /**
     * Fetches the [LazyGridItemInfo] for the interacted item, based on its key.
     */
    fun getLazyGridItemInfo(gridState: LazyGridState): LazyGridItemInfo?

    /**
     * Increments the cumulated offset by the updated [Offset] value.
     * This allows us to track the item's current point in space as it is moved.
     */
    fun incrementCumulatedOffset(offset: Offset): InteractionState

    /**
     * None represents an inactive state, or an object that is not being interacted with.
     */
    data object None : InteractionState {
        override val index: Int? = null
        override val key: String? = null
        override val cumulatedOffset: Offset = Offset.Zero
        override val initialOffset: Offset = Offset.Zero
        override fun getLazyGridItemInfo(gridState: LazyGridState): LazyGridItemInfo? {
            return null
        }

        override fun incrementCumulatedOffset(offset: Offset): InteractionState {
            return this
        }
    }

    /**
     * Active represents an active state, or an object that is being interacted with.
     */
    data class Active(
        override val index: Int,
        override val key: String,
        override val initialOffset: Offset,
        override val cumulatedOffset: Offset = Offset.Zero,
    ) : InteractionState {

        override fun incrementCumulatedOffset(offset: Offset): Active {
            return this.copy(cumulatedOffset = cumulatedOffset + offset)
        }

        override fun getLazyGridItemInfo(gridState: LazyGridState): LazyGridItemInfo? {
            return gridState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == this.key }
        }
    }
}
