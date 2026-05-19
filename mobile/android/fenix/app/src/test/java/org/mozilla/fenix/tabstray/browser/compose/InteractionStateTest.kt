/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.browser.compose

import androidx.compose.foundation.lazy.grid.LazyGridItemInfo
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.ui.geometry.Offset
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.assertNull
import org.mozilla.fenix.tabstray.browser.compose.interactable.InteractionState
import kotlin.test.Test
import kotlin.test.assertEquals

class InteractionStateTest {

    @Test
    fun `GIVEN None State WHEN incrementCumulatedOffset is called THEN None is returned unchnaged`() {
        val result = InteractionState.None.incrementCumulatedOffset(Offset(10f, 10f))
        assertEquals(InteractionState.None, result)
    }

    @Test
    fun `GIVEN Active State with initial offset Zero WHEN incrementCumulatedOffset is called THEN State is updated`() {
        val initialState = InteractionState.Active(index = 0, key = "key", initialOffset = Offset.Zero)
        val result = initialState.incrementCumulatedOffset(Offset(10f, 10f))
        assertEquals(result.cumulatedOffset, Offset(10f, 10f))
    }

    @Test
    fun `GIVEN Active State WHEN incrementCumulatedOffset is called THEN State is accumulated`() {
        val initialState = InteractionState.Active(index = 0, key = "key", initialOffset = Offset(10f, 10f))
        val result = initialState
            .incrementCumulatedOffset(Offset(10f, 10f))
            .incrementCumulatedOffset(Offset(10f, 10f))
            .incrementCumulatedOffset(Offset(10f, 10f))
        assertEquals(Offset(30f, 30f), result.cumulatedOffset)
    }

    @Test
    fun `GIVEN None state when lazyGridItemInfo is called THEN null is returned`() {
        val mockItem = mockk<LazyGridItemInfo>()
        val gridState = mockk<LazyGridState> {
            every { layoutInfo } returns mockk {
                every { visibleItemsInfo } returns listOf(mockItem)
            }
        }
        assertNull(InteractionState.None.getLazyGridItemInfo(gridState))
    }

    @Test
    fun `Given Active state when lazyGridItemInfo is called with a matching item THEN that item is returned`() {
        val mockItem = mockk<LazyGridItemInfo> {
            every { key } returns "key"
            every { index } returns 0
        }
        val gridState = mockk<LazyGridState> {
            every { layoutInfo } returns mockk {
                every { visibleItemsInfo } returns listOf(mockItem)
            }
        }
        val result =
            InteractionState.Active(index = 0, key = "key", initialOffset = Offset.Zero).getLazyGridItemInfo(gridState)
        assertEquals(mockItem, result)
    }

    @Test
    fun `Given Active state when lazyGridItemInfo is called without a matching item THEN null is returned`() {
        val mockItem = mockk<LazyGridItemInfo> {
            every { key } returns "otherKey"
            every { index } returns 1
        }
        val gridState = mockk<LazyGridState> {
            every { layoutInfo } returns mockk {
                every { visibleItemsInfo } returns listOf(mockItem)
            }
        }
        val result =
            InteractionState.Active(index = 0, key = "key", initialOffset = Offset.Zero).getLazyGridItemInfo(gridState)
        assertNull(result)
    }
}
