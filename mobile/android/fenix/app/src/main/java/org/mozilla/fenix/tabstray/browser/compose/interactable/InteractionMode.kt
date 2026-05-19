/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.browser.compose.interactable

import androidx.compose.ui.geometry.Rect

/**
 * Defines the mode that an interactable grid or list is in, and holds source and target items.
 * The user may be reordering, dragging and dropping items, and so on.
 */
sealed interface InteractionMode {
    // The source [InteractionState] for the mode
    val source: InteractionState

    // The target [InteractionState] for the mode
    val target: InteractionState

    /**
     * Represents no interaction mode is currently happening
     * @property source [InteractionState], which is always [InteractionState.None]
     * @property target [InteractionState], which is always [InteractionState.None]
     */
    data object None : InteractionMode {
        override val source: InteractionState = InteractionState.None
        override val target: InteractionState = InteractionState.None
    }

    /**
     * Represents a source item placed next to a target item, either before or after.
     * @property source [InteractionState], which is always [InteractionState.Active]
     * @property target [InteractionState], which is always [InteractionState.Active]
     * @property placeAfter: Boolean representing whether to place the source item before or after the target
     * @property rect: Rect representing the reorder "gutter" target, to be used as a visual indicator.
     */
    data class Reordering(
        override val source: InteractionState.Active,
        override val target: InteractionState.Active,
        val placeAfter: Boolean = true,
        val rect: Rect? = null,
    ) : InteractionMode

    /**
     * Represents a source item dragged and dropped onto a target item.
     * @property source [InteractionState], which is always [InteractionState.Active]
     * @property target [InteractionState], which is always [InteractionState.Active]
     */
    data class DragAndDrop(
        override val source: InteractionState.Active,
        override val target: InteractionState.Active,
    ) : InteractionMode

    /**
     * Represents a user attempting to scroll up or down the list or grid.
     * @property scroll: [Float] representing the scroll amount, which may be negative.
     * @property source [InteractionState], which is always [InteractionState.None]
     * @property target [InteractionState], which is always [InteractionState.None]
     */
    data class Scroll(
        val scroll: Float,
        override val source: InteractionState.None = InteractionState.None,
        override val target: InteractionState.None = InteractionState.None,
    ) : InteractionMode
}
