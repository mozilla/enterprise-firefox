/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components.menu

import android.content.Context
import androidx.navigation.NavController
import androidx.navigation.NavDirections
import androidx.navigation.NavOptions
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.runs
import io.mockk.slot
import io.mockk.spyk
import io.mockk.verify
import kotlinx.coroutines.test.runTest
import mozilla.components.browser.state.action.ShareResourceAction
import mozilla.components.browser.state.state.BrowserState
import mozilla.components.browser.state.state.ContentState
import mozilla.components.browser.state.state.CustomTabConfig
import mozilla.components.browser.state.state.CustomTabSessionState
import mozilla.components.browser.state.state.ReaderState
import mozilla.components.browser.state.state.content.ShareResourceState
import mozilla.components.browser.state.state.createTab
import mozilla.components.browser.state.store.BrowserStore
import mozilla.components.concept.engine.prompt.ShareData
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.R
import org.mozilla.fenix.components.share.ShareSheetLauncherImpl
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ShareSheetLauncherTest {

    private val mockContext = mockk<Context>(relaxed = true)
    private val mockNavController: NavController = mockk(relaxed = true) {
        every { currentDestination?.id } returns R.id.menuDialogFragment
        every { navigate(any<NavDirections>(), any<NavOptions>()) } just runs
        every { context } returns mockContext
    }

    private val contentTab = createTab(
        id = "customTab1",
        url = "content://www.mozilla.org",
    )
    private val browserStore = spyk(
        BrowserStore(BrowserState(tabs = listOf(contentTab), selectedTabId = contentTab.id)),
    )

    private val launcher = ShareSheetLauncherImpl(
        browserStore = browserStore,
        navController = mockNavController,
        onDismiss = {},
    )

    @Test
    fun `WHEN custom share sheet triggered AND non-content url provided THEN navigation updated`() = runTest {
        launcher.showCustomShareSheet(
            id = "123",
            url = "https://www.mozilla.org",
            title = "Mozilla",
            isCustomTab = false,
        )
        verify {
            mockNavController.navigate(any<NavDirections>(), any<NavOptions>())
        }
    }

    @Test
    fun `WHEN custom share sheet triggered AND content url provided THEN browser store updated`() = runTest {
        launcher.showCustomShareSheet(
            id = "123",
            url = "content://www.mozilla.org",
            title = "Mozilla",
            isCustomTab = true,
        )
        verify {
            browserStore.dispatch(any<ShareResourceAction.AddShareAction>())
        }
    }

    @Test
    fun `WHEN native share sheet triggered THEN activity triggered`() {
        launcher.showNativeShareSheet(
            id = "123",
            url = "https://www.mozilla.org",
            title = "Mozilla",
        )
        verify {
            mockContext.startActivity(any())
        }
    }

    @Test
    fun `GIVEN reader view is active WHEN navigate to share action is dispatched THEN navigate to share sheet`() = runTest {
        val title = "Mozilla"
        val readerUrl = "moz-extension://1234"
        val activeUrl = "https://mozilla.org"
        val readerTab = createTab(
            url = readerUrl,
            readerState = ReaderState(active = true, activeUrl = activeUrl),
            title = title,
        )
        val directionsSlot = slot<NavDirections>()
        val optionsSlot = slot<NavOptions>()
        launcher.showCustomShareSheet(
            id = readerTab.id,
            url = activeUrl,
            title = title,
            isCustomTab = false,
        )

        verify {
            mockNavController.navigate(
                capture(directionsSlot),
                capture(optionsSlot),
            )
        }

        val directions = directionsSlot.captured
        val directionsBundle = directions.arguments
        val shareData = directionsBundle.getParcelableArray("data", ShareData::class.java)?.firstOrNull()

        assertEquals(R.id.action_global_shareFragment, directions.actionId)
        assertNotNull(directionsBundle)
        assertEquals(readerTab.id, directionsBundle.getString("sessionId"))
        assertTrue(directionsBundle.getBoolean("showPage"))
        assertNotNull(shareData)
        assertEquals(activeUrl, shareData?.url)
        assertEquals(title, shareData?.title)

        assertEquals(R.id.browserFragment, optionsSlot.captured.popUpToId)
        assertFalse(optionsSlot.captured.isPopUpToInclusive())
    }

    @Test
    fun `GIVEN reader view is inactive WHEN navigate to share action is dispatched THEN navigate to share sheet`() = runTest {
        val url = "https://www.mozilla.org"
        val title = "Mozilla"
        val tab = createTab(
            url = url,
            title = title,
        )

        val directionsSlot = slot<NavDirections>()
        val optionsSlot = slot<NavOptions>()

        launcher.showCustomShareSheet(
            id = tab.id,
            url = url,
            title = title,
            isCustomTab = false,
        )

        verify {
            mockNavController.navigate(
                capture(directionsSlot),
                capture(optionsSlot),
            )
        }

        val directions = directionsSlot.captured
        val directionsBundle = directions.arguments
        val shareData = directionsBundle.getParcelableArray("data", ShareData::class.java)?.firstOrNull()

        assertEquals(R.id.action_global_shareFragment, directions.actionId)
        assertNotNull(directionsBundle)
        assertEquals(tab.id, directionsBundle.getString("sessionId"))
        assertTrue(directionsBundle.getBoolean("showPage"))
        assertNotNull(shareData)
        assertEquals(url, shareData?.url)
        assertEquals(title, shareData?.title)

        assertEquals(R.id.browserFragment, optionsSlot.captured.popUpToId)
        assertFalse(optionsSlot.captured.isPopUpToInclusive())
    }

    @Test
    fun `GIVEN the current tab is a local PDF WHEN share menu item is pressed THEN trigger ShareResourceAction`() = runTest {
        val id = "1"
        val url = "content://pdf.pdf"
        val title = "title"
        val tab = createTab(
            url = url,
            id = id,
        )
        launcher.showCustomShareSheet(
            id = tab.id,
            url = url,
            title = title,
            isCustomTab = true,
        )

        verify {
            browserStore.dispatch(
                ShareResourceAction.AddShareAction(
                    id,
                    ShareResourceState.LocalResource(url),
                ),
            )
        }
    }

    @Test
    fun `GIVEN the current tab is a custom tab WHEN navigate to share action is dispatched THEN navigate to share sheet`() = runTest {
        val url = "https://www.mozilla.org"
        val title = "Mozilla"
        val customTab = CustomTabSessionState(
            content = ContentState(
                url = url,
                title = title,
            ),
            config = CustomTabConfig(),
        )

        val directionsSlot = slot<NavDirections>()
        val optionsSlot = slot<NavOptions>()
        launcher.showCustomShareSheet(
            id = customTab.id,
            url = url,
            title = title,
            isCustomTab = true,
        )
        verify {
            mockNavController.navigate(
                capture(directionsSlot),
                capture(optionsSlot),
            )
        }

        val directions = directionsSlot.captured
        val directionsBundle = directions.arguments
        val shareData = directionsBundle.getParcelableArray("data", ShareData::class.java)?.firstOrNull()

        assertEquals(R.id.action_global_shareFragment, directions.actionId)
        assertNotNull(directionsBundle)
        assertEquals(customTab.id, directionsBundle.getString("sessionId"))
        assertTrue(directionsBundle.getBoolean("showPage"))
        assertNotNull(shareData)
        assertEquals(url, shareData?.url)
        assertEquals(title, shareData?.title)

        assertEquals(R.id.externalAppBrowserFragment, optionsSlot.captured.popUpToId)
        assertFalse(optionsSlot.captured.isPopUpToInclusive())
    }
}
