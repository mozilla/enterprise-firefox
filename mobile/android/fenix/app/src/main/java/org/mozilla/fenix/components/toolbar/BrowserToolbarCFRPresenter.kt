/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components.toolbar

import android.content.Context
import androidx.annotation.VisibleForTesting
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChangedBy
import mozilla.components.browser.state.selector.selectedNormalTab
import mozilla.components.browser.state.store.BrowserStore
import mozilla.components.browser.toolbar.BrowserToolbar
import mozilla.components.compose.cfr.CFRPopup
import mozilla.components.compose.cfr.CFRPopup.PopupAlignment.BODY_TO_ANCHOR_CENTER
import mozilla.components.compose.cfr.CFRPopupProperties
import mozilla.components.lib.state.ext.flowScoped
import mozilla.components.ui.colors.NovaColors
import mozilla.telemetry.glean.private.NoExtras
import org.mozilla.fenix.GleanMetrics.Events
import org.mozilla.fenix.R
import org.mozilla.fenix.ext.components
import org.mozilla.fenix.theme.FirefoxTheme
import org.mozilla.fenix.utils.Settings
import mozilla.components.browser.toolbar.R as toolbarR

private const val TAB_SWIPE_CFR_ARROW_OFFSET = 160

/**
 * Delegate for handling all the business logic for showing CFRs in the toolbar.
 *
 * @param context used for various Android interactions.
 * @param browserStore will be observed for tabs updates
 * @param settings used to read and write persistent user settings
 * @param toolbar will serve as anchor for the CFRs
 * @param isPrivate Whether or not the session is private.
 * @param mainDispatcher The [CoroutineDispatcher] to be used for observing the browser store.
 */
@Suppress("LongParameterList")
class BrowserToolbarCFRPresenter(
    private val context: Context,
    private val browserStore: BrowserStore,
    private val settings: Settings,
    private val toolbar: BrowserToolbar,
    private val isPrivate: Boolean,
    private val mainDispatcher: CoroutineDispatcher = Dispatchers.Main,
) {
    @VisibleForTesting
    internal var scope: CoroutineScope? = null

    @VisibleForTesting
    internal var popup: CFRPopup? = null

    /**
     * Start observing [browserStore] for updates which may trigger showing a CFR.
     */
    @Suppress("MagicNumber")
    fun start() {
        @Suppress("ComplexCondition")
        if (!isPrivate && !settings.hasShownTabSwipeCFR &&
            !settings.isTabStripEnabled && settings.isSwipeToolbarToSwitchTabsEnabled
        ) {
            scope = browserStore.flowScoped(dispatcher = mainDispatcher) { flow ->
                flow
                    .distinctUntilChangedBy { it.selectedNormalTab?.id }
                    .collect {
                        if (settings.shouldShowTabSwipeCFR &&
                            !settings.hasShownTabSwipeCFR &&
                            settings.cfrPopupsEnabled
                        ) {
                            scope?.cancel()
                            settings.shouldShowTabSwipeCFR = false
                            settings.hasShownTabSwipeCFR = true
                            showTabSwipeCFR()
                        }
                    }
            }
        }
    }

    /**
     * Stop listening for [browserStore] updates.
     * CFRs already shown are not automatically dismissed.
     */
    fun stop() {
        scope?.cancel()
    }

    @VisibleForTesting
    internal fun showTabSwipeCFR() {
        CFRPopup(
            anchor = toolbar.findViewById(
                toolbarR.id.mozac_browser_toolbar_background,
            ),
            properties = CFRPopupProperties(
                popupAlignment = BODY_TO_ANCHOR_CENTER,
                dismissButtonColor = NovaColors.White.toArgb(),
                indicatorDirection = if (context.components.settings.toolbarPosition == ToolbarPosition.TOP) {
                    CFRPopup.IndicatorDirection.UP
                } else {
                    CFRPopup.IndicatorDirection.DOWN
                },
                indicatorArrowStartOffset = TAB_SWIPE_CFR_ARROW_OFFSET.dp,
            ),
            onDismiss = {
                Events.toolbarTabSwipeCfrDismissed.record(NoExtras())
                popup = null
            },
            text = {
                FirefoxTheme {
                    Column {
                        Text(
                            text = context.getString(R.string.address_bar_swipe_cfr_message_2),
                            color = NovaColors.White,
                            style = FirefoxTheme.typography.body2,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                }
            },
        ).run {
            Events.toolbarTabSwipeCfrShown.record(NoExtras())
            popup = this
            show()
        }
    }
}
