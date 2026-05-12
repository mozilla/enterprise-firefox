/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.ipprotection

import kotlinx.coroutines.flow.Flow

/**
 * Storage exposing the availability of the IP Protection feature.
 */
interface IPProtectionAvailabilityStorage {
    /**
     * Emits whether the IP Protection feature is currently available to the user.
     */
    val isFeatureAvailable: Flow<Boolean>

    /**
     * Initializes the storage.
     */
    fun init()
}
