/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.browser.compose

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.IntSize
import org.mozilla.fenix.tabstray.browser.compose.interactable.GridItemOffset
import org.mozilla.fenix.tabstray.browser.compose.interactable.InteractionState

fun fakeActiveState(key: String = "key"): InteractionState.Active {
    return InteractionState.Active(
        index = 0,
        key = key,
        initialOffset = Offset.Zero,
    )
}

fun fakeDraggedItemOffset(): GridItemOffset {
    val draggedItem = InteractionState.Active(
        index = 0,
        key = "key",
        initialOffset = Offset.Zero,
    )
    return GridItemOffset(
        draggedItem = draggedItem,
        draggingItemOffset = Offset.Zero,
        itemSize = IntSize(2, 2),
    )
}
