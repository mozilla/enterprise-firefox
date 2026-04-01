/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.data

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import org.mozilla.fenix.theme.FirefoxTheme

/**
 * Value class representing the possible themes for Tab Groups.
 **/
enum class TabGroupTheme {
    Yellow {
        override val primary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.yellow.primary

        override val onPrimary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.yellow.onPrimary

        override val contentLabel: String
            @ReadOnlyComposable @Composable get() = this.name
    },

    Orange {
        override val primary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.orange.primary

        override val onPrimary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.orange.onPrimary

        override val contentLabel: String
            @ReadOnlyComposable @Composable get() = this.name
    },

    Red {
        override val primary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.red.primary

        override val onPrimary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.red.onPrimary

        override val contentLabel: String
            @ReadOnlyComposable @Composable get() = this.name
    },

    Pink {
        override val primary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.pink.primary

        override val onPrimary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.pink.onPrimary

        override val contentLabel: String
            @ReadOnlyComposable @Composable get() = this.name
    },

    Purple {
        override val primary: Color
            @Composable get() = FirefoxTheme.tabGroupColors.purple.primary

        override val onPrimary: Color
            @Composable get() = FirefoxTheme.tabGroupColors.purple.onPrimary

        override val contentLabel: String
            @Composable get() = this.name
    },

    Violet {
        override val primary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.violet.primary

        override val onPrimary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.violet.onPrimary

        override val contentLabel: String
            @ReadOnlyComposable @Composable get() = this.name
    },

    Blue {
        override val primary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.blue.primary

        override val onPrimary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.blue.onPrimary

        override val contentLabel: String
            @ReadOnlyComposable @Composable get() = this.name
    },

    Cyan {
        override val primary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.cyan.primary

        override val onPrimary: Color
            @Composable get() = FirefoxTheme.tabGroupColors.cyan.onPrimary

        override val contentLabel: String
            @Composable get() = this.name
    },

    Green {
        override val primary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.green.primary

        override val onPrimary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.green.onPrimary

        override val contentLabel: String
            @ReadOnlyComposable @Composable get() = this.name
    },

    Grey {
        override val primary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.grey.primary

        override val onPrimary: Color
            @ReadOnlyComposable @Composable get() = FirefoxTheme.tabGroupColors.grey.onPrimary

        override val contentLabel: String
            @ReadOnlyComposable @Composable get() = this.name
    },
    ;

    /**
     * The primary color of the tab group.
     **/
    @get:Composable
    @get:ReadOnlyComposable
    abstract val primary: Color

    /**
     * The color of content displayed on top of [primary].
     **/
    @get:Composable
    @get:ReadOnlyComposable
    abstract val onPrimary: Color

    /**
     * The accessibility label for this theme.
     * //todo replace with localized text
     */
    @get:Composable
    @get:ReadOnlyComposable
    abstract val contentLabel: String

    companion object {
        /**
         * The color of content displayed on top of [primary].
         **/
        val default: TabGroupTheme = Yellow
    }
}
