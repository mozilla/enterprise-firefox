/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.ipprotection

import mozilla.components.ExperimentalAndroidComponentsApi
import mozilla.components.concept.engine.ipprotection.IPProtectionHandler.StateInfo
import mozilla.components.concept.engine.ipprotection.IPProtectionHandler.StateInfo.Companion.PROXY_STATE_ACTIVATING
import mozilla.components.concept.engine.ipprotection.IPProtectionHandler.StateInfo.Companion.PROXY_STATE_ACTIVE
import mozilla.components.concept.engine.ipprotection.IPProtectionHandler.StateInfo.Companion.PROXY_STATE_ERROR
import mozilla.components.concept.engine.ipprotection.IPProtectionHandler.StateInfo.Companion.PROXY_STATE_NOT_READY
import mozilla.components.concept.engine.ipprotection.IPProtectionHandler.StateInfo.Companion.PROXY_STATE_PAUSED
import mozilla.components.concept.engine.ipprotection.IPProtectionHandler.StateInfo.Companion.PROXY_STATE_READY
import mozilla.components.concept.engine.ipprotection.IPProtectionHandler.StateInfo.Companion.SERVICE_STATE_READY
import mozilla.components.concept.engine.ipprotection.IPProtectionHandler.StateInfo.Companion.SERVICE_STATE_UNAUTHENTICATED
import mozilla.components.concept.engine.ipprotection.IPProtectionHandler.StateInfo.Companion.SERVICE_STATE_UNAVAILABLE
import mozilla.components.concept.engine.ipprotection.IPProtectionHandler.StateInfo.Companion.SERVICE_STATE_UNINITIALIZED
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalAndroidComponentsApi::class)
class IPProtectionReducerTest {

    private val defaultState = IPProtectionState()

    @Test
    fun `WHEN EligibilityChanged is dispatched THEN eligibilityStatus is updated`() {
        assertEquals(
            defaultState.copy(eligibilityStatus = EligibilityStatus.Eligible),
            iPProtectionReducer(
                defaultState,
                IPProtectionAction.EligibilityChanged(EligibilityStatus.Eligible),
            ),
        )
    }

    @Test
    fun `WHEN AccountStateChanged is dispatched THEN isSignedIn is updated`() {
        assertEquals(
            defaultState.copy(isSignedIn = true),
            iPProtectionReducer(
                defaultState,
                IPProtectionAction.AccountStateChanged(isSignedIn = true),
            ),
        )
    }

    @Test
    fun `WHEN ToolkitStateChanged is dispatched THEN data fields are updated`() {
        val info = StateInfo(
            serviceState = SERVICE_STATE_UNINITIALIZED,
            remaining = 1000L,
            max = 5000L,
            resetTime = "2026-06-01T00:00:00Z",
        )
        assertEquals(
            defaultState.copy(
                dataRemainingBytes = 1000L,
                dataMaxBytes = 5000L,
                resetDate = "2026-06-01T00:00:00Z",
            ),
            iPProtectionReducer(defaultState, IPProtectionAction.EngineStateChanged(info)),
        )
    }

    @Test
    fun `WHEN service state is uninitialized THEN proxyStatus is Uninitialized`() {
        val info = StateInfo(serviceState = SERVICE_STATE_UNINITIALIZED)
        assertEquals(
            defaultState.copy(proxyStatus = Uninitialized),
            iPProtectionReducer(defaultState, IPProtectionAction.EngineStateChanged(info)),
        )
    }

    @Test
    fun `WHEN service state is unavailable THEN proxyStatus is Uninitialized`() {
        val info = StateInfo(serviceState = SERVICE_STATE_UNAVAILABLE)
        assertEquals(
            defaultState.copy(proxyStatus = Uninitialized),
            iPProtectionReducer(defaultState, IPProtectionAction.EngineStateChanged(info)),
        )
    }

    // NB toolkit collapses non-authenticated and non-authorized cases into one state
    @Test
    fun `WHEN service state is unauthenticated and user is signed in THEN proxyStatus is AuthorizationRequired`() {
        val before = defaultState.copy(isSignedIn = true)
        val info = StateInfo(serviceState = SERVICE_STATE_UNAUTHENTICATED)
        assertEquals(
            before.copy(proxyStatus = AuthorizationRequired),
            iPProtectionReducer(before, IPProtectionAction.EngineStateChanged(info)),
        )
    }

    // NB toolkit collapses non-authenticated and non-authorized cases into one state
    @Test
    fun `WHEN service state is unauthenticated and user is not signed in THEN proxyStatus is AuthenticationRequired`() {
        val info = StateInfo(serviceState = SERVICE_STATE_UNAUTHENTICATED)
        assertEquals(
            defaultState.copy(proxyStatus = AuthenticationRequired),
            iPProtectionReducer(defaultState, IPProtectionAction.EngineStateChanged(info)),
        )
    }

    @Test
    fun `WHEN service is ready and proxy state is ready THEN proxyStatus is Idle`() {
        val info = StateInfo(serviceState = SERVICE_STATE_READY, proxyState = PROXY_STATE_READY)
        assertEquals(
            defaultState.copy(proxyStatus = Authorized.Idle),
            iPProtectionReducer(defaultState, IPProtectionAction.EngineStateChanged(info)),
        )
    }

    @Test
    fun `WHEN service is ready and proxy state is activating THEN proxyStatus is Activating`() {
        val info = StateInfo(serviceState = SERVICE_STATE_READY, proxyState = PROXY_STATE_ACTIVATING)
        assertEquals(
            defaultState.copy(proxyStatus = Authorized.Activating),
            iPProtectionReducer(defaultState, IPProtectionAction.EngineStateChanged(info)),
        )
    }

    @Test
    fun `WHEN service is ready and proxy state is active THEN proxyStatus is Active`() {
        val info = StateInfo(serviceState = SERVICE_STATE_READY, proxyState = PROXY_STATE_ACTIVE)
        assertEquals(
            defaultState.copy(proxyStatus = Authorized.Active),
            iPProtectionReducer(defaultState, IPProtectionAction.EngineStateChanged(info)),
        )
    }

    @Test
    fun `WHEN service is ready and proxy state is paused THEN proxyStatus is DataLimitReached`() {
        val info = StateInfo(serviceState = SERVICE_STATE_READY, proxyState = PROXY_STATE_PAUSED)
        assertEquals(
            defaultState.copy(proxyStatus = Authorized.DataLimitReached),
            iPProtectionReducer(defaultState, IPProtectionAction.EngineStateChanged(info)),
        )
    }

    @Test
    fun `WHEN service is ready and proxy state is error THEN proxyStatus is ConnectionError`() {
        val info = StateInfo(serviceState = SERVICE_STATE_READY, proxyState = PROXY_STATE_ERROR)
        assertEquals(
            defaultState.copy(proxyStatus = Authorized.ConnectionError),
            iPProtectionReducer(defaultState, IPProtectionAction.EngineStateChanged(info)),
        )
    }

    @Test
    fun `WHEN service is ready and proxy state is not ready THEN proxyStatus is Uninitialized`() {
        val info = StateInfo(serviceState = SERVICE_STATE_READY, proxyState = PROXY_STATE_NOT_READY)
        assertEquals(
            defaultState.copy(proxyStatus = Uninitialized),
            iPProtectionReducer(defaultState, IPProtectionAction.EngineStateChanged(info)),
        )
    }

    @Test
    fun `WHEN service state is an unknown value THEN proxyStatus is Uninitialized`() {
        val info = StateInfo(serviceState = 99)
        assertEquals(
            defaultState.copy(proxyStatus = Uninitialized),
            iPProtectionReducer(defaultState, IPProtectionAction.EngineStateChanged(info)),
        )
    }

    @Test
    fun `WHEN service is ready and proxy state is an unknown value THEN proxyStatus is Uninitialized`() {
        val info = StateInfo(serviceState = SERVICE_STATE_READY, proxyState = 99)
        assertEquals(
            defaultState.copy(proxyStatus = Uninitialized),
            iPProtectionReducer(defaultState, IPProtectionAction.EngineStateChanged(info)),
        )
    }
}
