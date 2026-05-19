/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.browser.compose

import org.junit.Assert.assertEquals
import org.junit.Test
import org.mozilla.fenix.tabstray.browser.compose.interactable.InteractionMode
import org.mozilla.fenix.tabstray.browser.compose.interactable.InteractionState

class InteractionModeTest {
    @Test
    fun `GIVEN None mode THEN source and target are both InteractionState None`() {
        assertEquals(InteractionMode.None.target, InteractionState.None)
        assertEquals(InteractionMode.None.source, InteractionState.None)
    }

    @Test
    fun `GIVEN Reorder mode THEN placeAfter defaults to true`() {
        val mode = InteractionMode.Reordering(
            source = fakeActiveState(),
            target = fakeActiveState(),
        )
        assertEquals(mode.placeAfter, true)
    }

    @Test
    fun `GIVEN Reorder mode WHEN source is accessed THEN constructor argument is preserved`() {
        val source = fakeActiveState(key = "key1")
        val target = fakeActiveState(key = "key2")
        val mode = InteractionMode.Reordering(
            source = source,
            target = target,
        )
        assertEquals(source, mode.source)
    }

    @Test
    fun `GIVEN Reorder mode WHEN target is accessed THEN constructor argument is preserved`() {
        val source = fakeActiveState(key = "key1")
        val target = fakeActiveState(key = "key2")
        val mode = InteractionMode.Reordering(
            source = source,
            target = target,
        )
        assertEquals(target, mode.target)
    }

    @Test
    fun `Given Scroll mode THEN source and target are None`() {
        assertEquals(InteractionState.None, InteractionMode.Scroll(0f).source)
        assertEquals(InteractionState.None, InteractionMode.Scroll(0f).target)
    }
}
