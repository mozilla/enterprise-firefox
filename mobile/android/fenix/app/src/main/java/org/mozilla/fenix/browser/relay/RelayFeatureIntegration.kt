/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.browser.relay

import mozilla.components.concept.engine.Engine
import mozilla.components.service.fxa.manager.FxaAccountManager
import mozilla.components.service.fxrelay.eligibility.RelayEligibilityStore
import mozilla.components.service.fxrelay.eligibility.RelayFeature
import mozilla.components.support.base.feature.LifecycleAwareFeature

/**
 * A wrapper class for features that relate to the Firefox Relay email masking service.
 */
class RelayFeatureIntegration(
    private val engine: Engine,
    private val store: RelayEligibilityStore,
    private val accountManager: FxaAccountManager,
) : LifecycleAwareFeature {
    private val relayFeature by lazy {
        RelayFeature(
            accountManager = accountManager,
            store = store,
        )
    }
    private val emailMaskEngineUpdater by lazy {
        EmailMaskEngineUpdater(engine, store)
    }
    override fun start() {
        relayFeature.start()
        emailMaskEngineUpdater.start()
    }

    override fun stop() {
        relayFeature.stop()
        emailMaskEngineUpdater.stop()
    }
}
