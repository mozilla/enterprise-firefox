/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.ipprotection

import mozilla.components.ExperimentalAndroidComponentsApi
import mozilla.components.concept.engine.ipprotection.IPProtectionHandler
import mozilla.components.lib.state.Action
import mozilla.components.lib.state.Middleware
import mozilla.components.lib.state.Reducer
import mozilla.components.lib.state.Store

/**
 * Actions that can be dispatched to [IPProtectionStore].
 */
@OptIn(ExperimentalAndroidComponentsApi::class)
sealed class IPProtectionAction : Action {
    /**
     * Reports a change in whether the user qualifies for IP Protection.
     */
    data class EligibilityChanged(val eligibility: EligibilityStatus) : IPProtectionAction()

    /**
     * Reports a fresh snapshot from the GeckoView IP protection toolkit.
     */
    data class EngineStateChanged(val info: IPProtectionHandler.StateInfo) : IPProtectionAction()

    /**
     * Reports a change in whether the user is signed in to a Firefox Account.
     */
    data class AccountStateChanged(val isSignedIn: Boolean) : IPProtectionAction()
}

@OptIn(ExperimentalAndroidComponentsApi::class)
internal fun iPProtectionReducer(
    state: IPProtectionState,
    action: IPProtectionAction,
): IPProtectionState = when (action) {
    is IPProtectionAction.EligibilityChanged -> {
        state.copy(eligibilityStatus = action.eligibility)
    }

    is IPProtectionAction.EngineStateChanged -> state.copy(
        dataRemainingBytes = action.info.remaining,
        dataMaxBytes = action.info.max,
        resetDate = action.info.resetTime,
        proxyStatus = action.info.asProxyStatus(state.isSignedIn),
    )

    is IPProtectionAction.AccountStateChanged -> state.copy(
        isSignedIn = action.isSignedIn,
    )
}

@OptIn(ExperimentalAndroidComponentsApi::class)
private fun IPProtectionHandler.StateInfo.asProxyStatus(isSignedIn: Boolean): ProxyStatus {
    return when (serviceState) {
        IPProtectionHandler.StateInfo.SERVICE_STATE_UNINITIALIZED -> Uninitialized
        // NB: this service state means the toolkit is disabled through their own nimbus config
        IPProtectionHandler.StateInfo.SERVICE_STATE_UNAVAILABLE -> Uninitialized
        IPProtectionHandler.StateInfo.SERVICE_STATE_UNAUTHENTICATED -> {
            if (isSignedIn) {
                AuthorizationRequired
            } else {
                AuthenticationRequired
            }
        }

        IPProtectionHandler.StateInfo.SERVICE_STATE_READY -> when (proxyState) {
            IPProtectionHandler.StateInfo.PROXY_STATE_READY -> Authorized.Idle
            IPProtectionHandler.StateInfo.PROXY_STATE_ACTIVATING -> Authorized.Activating
            IPProtectionHandler.StateInfo.PROXY_STATE_ACTIVE -> Authorized.Active
            IPProtectionHandler.StateInfo.PROXY_STATE_PAUSED -> Authorized.DataLimitReached
            IPProtectionHandler.StateInfo.PROXY_STATE_ERROR -> Authorized.ConnectionError
            else -> Uninitialized
        }
        else -> Uninitialized
    }
}

/**
 * [Store] for IP protection feature state.
 */
class IPProtectionStore(
    initialState: IPProtectionState = IPProtectionState(),
    reducer: Reducer<IPProtectionState, IPProtectionAction> = ::iPProtectionReducer,
    middleware: List<Middleware<IPProtectionState, IPProtectionAction>> = emptyList(),
) : Store<IPProtectionState, IPProtectionAction>(initialState, reducer, middleware)
