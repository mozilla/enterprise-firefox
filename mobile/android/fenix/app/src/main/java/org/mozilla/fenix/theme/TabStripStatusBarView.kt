/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.theme

import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.FrameLayout.LayoutParams.MATCH_PARENT
import android.widget.FrameLayout.LayoutParams.WRAP_CONTENT
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy

/**
 * View class that sets the status bar background with the tab strip gradient by overlaying a
 * [ComposeView] on the given [rootView].
 *
 * @param rootView The [ViewGroup] container to embed the gradient overlay. This should be the window's decor view.
 */
class TabStripStatusBarView(private val rootView: ViewGroup) {

    private var composeView: ComposeView? = null

    /**
     * Shows the tab strip gradient by overlaying the [rootView].
     */
    fun show() {
        if (composeView != null) return

        composeView = ComposeView(rootView.context).apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
            setContent {
                FirefoxTheme {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .windowInsetsTopHeight(WindowInsets.statusBars)
                            .background(brush = FirefoxTheme.gradients.accentSubtle.brush),
                    )
                }
            }
        }

        rootView.addView(
            composeView,
            FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { gravity = Gravity.TOP },
        )
        // Keep the gradient above any other decor view overlay that shares the status bar region.
        rootView.bringChildToFront(composeView)
    }

    /**
     * Removes the gradient overlay from the [rootView], if present.
     */
    fun hide() {
        composeView?.let { rootView.removeView(it) }
        composeView = null
    }
}
