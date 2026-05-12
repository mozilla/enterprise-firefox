/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.ipprotection

/**
 * IP Protection proxy states.
 */
sealed interface ProxyStatus

/**
 * Proxy is not yet initialized.
 */
data object Uninitialized : ProxyStatus

/**
 * Sign in required.
 */
data object AuthenticationRequired : ProxyStatus

/**
 * FxA feature authorization is required.
 */
data object AuthorizationRequired : ProxyStatus

/**
 * Feature is ready for use.
 */
sealed interface Authorized : ProxyStatus {
    /**
     * Inactive, and could be turned on.
     */
    data object Idle : Authorized

    /**
     * In the process of activating the proxy.
     */
    data object Activating : Authorized

    /**
     * Proxy is active.
     */
    data object Active : Authorized

    /**
     * User has reached the data limit for this month.
     */
    data object DataLimitReached : Authorized

    /**
     * Errored while connecting to the proxy.
     */
    data object ConnectionError : ProxyStatus
}
