/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings

import android.content.SharedPreferences
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.mockk.Runs
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.spyk
import io.mockk.verify
import mozilla.components.support.test.robolectric.testContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.browser.browsingmode.BrowsingMode
import org.mozilla.fenix.components.AppStore
import org.mozilla.fenix.components.Components
import org.mozilla.fenix.components.appstate.AppState
import org.mozilla.fenix.ext.components
import org.mozilla.fenix.summarization.onboarding.FenixSummarizationFeatureConfiguration
import org.mozilla.fenix.utils.Settings

@RunWith(AndroidJUnit4::class)
class ToolbarSimpleShortcutPreferenceTest {

    private val context = spyk(testContext)
    private val components: Components = mockk()
    private val settings: Settings = mockk()
    private val summarizationFeatureSettings: FenixSummarizationFeatureConfiguration = mockk()
    private val preferencesEditor: SharedPreferences.Editor = mockk()

    @Before
    fun setUp() {
        every { context.components } returns components
        every { components.appStore } returns AppStore(AppState(mode = BrowsingMode.Normal))
        every { components.core.summarizeFeatureSettings } returns summarizationFeatureSettings
        every { summarizationFeatureSettings.canShowFeature } returns true
        every { components.settings } returns settings
        val preferences: SharedPreferences = mockk()
        every { preferences.edit() } returns preferencesEditor
        every { settings.preferences } returns preferences
        every { preferencesEditor.putBoolean(any(), any()) } returns preferencesEditor
        every { preferencesEditor.apply() } just Runs
        // No shortcut persisted by default, so the default option is selected.
        every { settings.toolbarSimpleShortcutKey } returns ""
    }

    @Test
    fun `GIVEN summarization is disabled WHEN getting the shortcut options THEN the summarize option is excluded`() {
        every { summarizationFeatureSettings.canShowFeature } returns false
        val preference = ToolbarSimpleShortcutPreference(context)

        val optionKeys = preference.getShortcutOptions().map { it.key }

        assertFalse(optionKeys.contains(ShortcutType.SUMMARIZE.value))
    }

    @Test
    fun `GIVEN summarization is enabled WHEN getting the shortcut options THEN the summarize option is included`() {
        val preference = ToolbarSimpleShortcutPreference(context)

        val optionKeys = preference.getShortcutOptions().map { it.key }

        assertTrue(optionKeys.contains(ShortcutType.SUMMARIZE.value))
    }

    @Test
    fun `GIVEN summarization enabled and normal browsing WHEN getting the shortcut options THEN all simple shortcut options are returned in order`() {
        val preference = ToolbarSimpleShortcutPreference(context)

        val optionKeys = preference.getShortcutOptions().map { it.key }

        assertEquals(simpleShortcutOptions.map { it.key.value }, optionKeys)
    }

    @Test
    fun `GIVEN summarization enabled and private browsing WHEN getting the shortcut options THEN the summarize option is shown but disabled`() {
        every { components.appStore } returns AppStore(AppState(mode = BrowsingMode.Private))
        val preference = ToolbarSimpleShortcutPreference(context)

        val options = preference.getShortcutOptions()

        // The summarize option is still listed, in order, but cannot be selected.
        assertEquals(simpleShortcutOptions.map { it.key.value }, options.map { it.key })
        val summarizeOption = options.first { it.key == ShortcutType.SUMMARIZE.value }
        assertFalse(summarizeOption.isEnabled)
        assertTrue(options.filterNot { it.key == ShortcutType.SUMMARIZE.value }.all { it.isEnabled })
    }

    @Test
    fun `GIVEN summarization enabled and normal browsing WHEN getting the shortcut options THEN the summarize option is shown and enabled`() {
        val preference = ToolbarSimpleShortcutPreference(context)

        val options = preference.getShortcutOptions()

        val summarizeOption = options.first { it.key == ShortcutType.SUMMARIZE.value }
        assertTrue(summarizeOption.isEnabled)
    }

    @Test
    fun `GIVEN a persisted selected key WHEN getting the shortcut options THEN the matching option is checked`() {
        every { settings.toolbarSimpleShortcutKey } returns ShortcutType.SHARE.value
        val preference = ToolbarSimpleShortcutPreference(context)

        preference.getShortcutOptions()

        verify { preferencesEditor.putBoolean(ShortcutType.SHARE.value, true) }
        verify { preferencesEditor.putBoolean(ShortcutType.NEW_TAB.value, false) }
    }

    @Test
    fun `GIVEN an unknown persisted key WHEN getting the shortcut options THEN the first option is selected by default`() {
        every { settings.toolbarSimpleShortcutKey } returns "an_unknown_key"
        val preference = ToolbarSimpleShortcutPreference(context)

        preference.getShortcutOptions()

        verify { preferencesEditor.putBoolean(simpleShortcutOptions.first().key.value, true) }
    }
}
