/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings.emailmasks

import android.os.Bundle
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.fragment.compose.content
import mozilla.components.lib.state.helpers.StoreProvider.Companion.fragmentStore
import org.mozilla.fenix.BrowserDirection
import org.mozilla.fenix.HomeActivity
import org.mozilla.fenix.R
import org.mozilla.fenix.ext.settings
import org.mozilla.fenix.ext.showToolbar
import org.mozilla.fenix.settings.emailmasks.middleware.EmailMasksNavigationMiddleware
import org.mozilla.fenix.settings.emailmasks.middleware.EmailMasksPreferencesMiddleware
import org.mozilla.fenix.settings.emailmasks.middleware.EmailMasksTelemetryMiddleware
import org.mozilla.fenix.theme.FirefoxTheme

/**
 * Fragment host for the Email Masks settings screen.
 */
class EmailMasksSettingsFragment : Fragment() {
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ) = content {
        FirefoxTheme {
            val store by fragmentStore(
                initialState = EmailMasksState(
                    isSuggestMasksEnabled = requireContext().settings().isEmailMaskSuggestionEnabled,
                ),
            ) { state -> createEmailMasksStore(state) }

            EmailMasksSettingsScreen(store)
        }
    }

    override fun onResume() {
        super.onResume()
        showToolbar(getString(R.string.preferences_email_masks))
    }

    private fun createEmailMasksStore(initialState: EmailMasksState) = EmailMasksStore(
        initialState = initialState,
        middleware = listOf(
            EmailMasksNavigationMiddleware(
                openTab = { url ->
                    (activity as? HomeActivity)?.openToBrowserAndLoad(
                        searchTermOrURL = url,
                        newTab = true,
                        from = BrowserDirection.FromSettings,
                    )
                },
            ),
            EmailMasksPreferencesMiddleware(
                persistSuggestToggle = { enabled ->
                    requireContext().settings().isEmailMaskSuggestionEnabled = enabled
                },
            ),
            EmailMasksTelemetryMiddleware(),
        ),
    )
}
