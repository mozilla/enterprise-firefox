/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.redux.state

/**
 * The different pages in the Tab Manager.
 */
enum class Page {

    /**
     * The page that displays normal tabs.
     */
    NormalTabs,

    /**
     * The page that displays private tabs.
     */
    PrivateTabs,

    /**
     * The page that displays Synced Tabs.
     */
    SyncedTabs,
    ;

    companion object {
        /**
         * Returns the [Page] that corresponds to the [position].
         *
         * @param position The index of the page.
         */
        fun positionToPage(
            position: Int,
        ): Page {
            return when (position) {
                0 -> PrivateTabs
                1 -> NormalTabs
                else -> SyncedTabs
            }
        }

        /**
         * Returns the visual index that corresponds to the [page].
         *
         * @param page The [Page] whose visual index is being looked-up.
         */
        fun pageToPosition(
            page: Page,
        ): Int {
            return when (page) {
                PrivateTabs -> 0
                NormalTabs -> 1
                SyncedTabs -> 2
            }
        }
    }
}
