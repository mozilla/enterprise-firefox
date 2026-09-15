/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components.menu

import android.app.Dialog
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.animation.OvershootInterpolator
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CornerSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat.Type.systemBars
import androidx.fragment.compose.content
import com.google.android.material.R as materialR
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.bottomsheet.BottomSheetDialogFragment
import mozilla.components.compose.menu.Menu
import mozilla.components.compose.menu.data.MenuItemsGroup
import mozilla.components.compose.menu.store.MenuState
import mozilla.components.compose.menu.store.MenuStore
import mozilla.components.lib.state.helpers.StoreProvider.Companion.composableStore
import mozilla.components.support.ktx.android.util.dpToPx
import mozilla.components.support.utils.ext.getWindowInsets
import mozilla.components.support.utils.ext.isLandscape
import mozilla.components.support.utils.ext.pixelSizeFor
import mozilla.components.support.utils.ext.top
import mozilla.telemetry.glean.private.NoExtras
import org.mozilla.fenix.GleanMetrics.Events
import org.mozilla.fenix.R
import org.mozilla.fenix.components.menu.compose.MenuDialogBottomSheet
import org.mozilla.fenix.components.menu.compose.MenuHandleState
import org.mozilla.fenix.theme.FirefoxTheme

private const val EXPANDED_OFFSET = 56
private const val HIDING_FRICTION = 0.9f
private const val MENU_ANIMATION_DURATION = 300L
private const val MENU_ANIMATION_START_OFFSET_RATIO = 0.2f

/** A bottom sheet fragment hosting the customizable menu. */
class MenuFragment : BottomSheetDialogFragment() {

    private val snackbarHostState = SnackbarHostState()
    private var bottomSheetBehavior: BottomSheetBehavior<View>? = null

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        Events.toolbarMenuVisible.record(NoExtras())

        return object : BottomSheetDialog(requireContext(), theme) {
                override fun onKeyDown(
                    keyCode: Int,
                    event: KeyEvent,
                ): Boolean {
                    if (event.action == KeyEvent.ACTION_DOWN && event.keyCode == KeyEvent.KEYCODE_MENU) {
                        dismiss()
                        return true
                    }
                    return super.onKeyDown(keyCode, event)
                }
            }
            .apply {
                setOnShowListener {
                    val bottomSheet = findViewById<View?>(materialR.id.design_bottom_sheet)

                    bottomSheet?.let {
                        ViewCompat.setOnApplyWindowInsetsListener(it) { view, insets ->
                            val systemBarInsets = insets.getInsets(systemBars())
                            view.setPadding(0, systemBarInsets.top, 0, systemBarInsets.bottom)
                            insets
                        }
                    }
                    bottomSheet?.setBackgroundResource(R.drawable.bottom_sheet_with_top_rounded_corners)

                    // https://bugzilla.mozilla.org/show_bug.cgi?id=1982004
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                        bottomSheet?.let { sheet ->
                            sheet.translationY = sheet.height * MENU_ANIMATION_START_OFFSET_RATIO
                            sheet
                                .animate()
                                .translationY(0f)
                                .setInterpolator(OvershootInterpolator())
                                .setDuration(MENU_ANIMATION_DURATION)
                                .start()
                        }
                    }

                    bottomSheetBehavior = bottomSheet?.let {
                        BottomSheetBehavior.from(it).apply {
                            maxWidth = calculateMenuSheetWidth()
                            peekHeight = resources.displayMetrics.heightPixels
                            maxHeight = calculateMenuSheetHeight()
                            skipCollapsed = true
                            state = BottomSheetBehavior.STATE_EXPANDED
                            hideFriction = HIDING_FRICTION
                        }
                    }
                }
            }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        bottomSheetBehavior?.apply {
            maxWidth = calculateMenuSheetWidth()
            maxHeight = calculateMenuSheetHeight()
        }
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ) = content {
        val menuStore by
            composableStore(MenuState(buildInitialMenuState())) {
                buildMenuStore(it)
            }

        FirefoxTheme {
            BackHandler { dismissAllowingStateLoss() }

            MenuDialogBottomSheet(
                modifier =
                    Modifier.padding(vertical = FirefoxTheme.layout.space.static200)
                        .width(FirefoxTheme.layout.space.static400),
                onRequestDismiss = ::dismiss,
                menuHandleState =
                    MenuHandleState(
                        contentDescription =
                            stringResource(R.string.browser_close_main_menu_handlebar_content_description)
                    ),
                snackbarHostState = snackbarHostState,
                cornerShape =
                    MaterialTheme.shapes.extraLarge.copy(
                        bottomStart = CornerSize(0.dp),
                        bottomEnd = CornerSize(0.dp),
                    ),
            ) {
                Menu(menuStore)
            }
        }
    }

    private fun calculateMenuSheetWidth(): Int {
        val isLandscape = requireContext().isLandscape()
        val screenWidthPx = requireContext().resources.configuration.screenWidthDp.dpToPx(resources.displayMetrics)
        val totalHorizontalPadding = 2 * pixelSizeFor(R.dimen.browser_menu_padding)
        val minScreenWidth = pixelSizeFor(R.dimen.browser_menu_max_width) + totalHorizontalPadding

        // We only want to restrict the width of the menu if the device is in landscape mode AND the
        // device's screen width is smaller than the menu's max width and total horizontal padding combined.
        // Otherwise, the menu being at max width would still leave sufficient padding on each side in landscape mode.
        return if (isLandscape && screenWidthPx < minScreenWidth) {
            screenWidthPx - totalHorizontalPadding
        } else {
            pixelSizeFor(R.dimen.browser_menu_max_width)
        }
    }

    private fun calculateMenuSheetHeight(): Int {
        val bottomSheet = dialog?.findViewById<View?>(materialR.id.design_bottom_sheet)
        val topBarHeight = bottomSheet?.getWindowInsets()?.top() ?: 0

        val orientationMaxHeight =
            if (requireContext().isLandscape()) {
                resources.displayMetrics.heightPixels
            } else {
                resources.displayMetrics.heightPixels - EXPANDED_OFFSET.dpToPx(resources.displayMetrics)
            }

        return orientationMaxHeight - topBarHeight
    }

    private fun buildInitialMenuState() = listOf<MenuItemsGroup>()

    private fun buildMenuStore(initialState: MenuState) =
        MenuStore(
            initialState = initialState,
            middleware = emptyList(),
        )
}
