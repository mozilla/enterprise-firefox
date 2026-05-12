/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.browser.engine.gecko.ipprotection

import androidx.annotation.OptIn
import mozilla.components.ExperimentalAndroidComponentsApi
import mozilla.components.concept.engine.ipprotection.IPProtectionHandler
import org.mozilla.geckoview.ExperimentalGeckoViewApi
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoRuntime

@OptIn(ExperimentalGeckoViewApi::class)
@kotlin.OptIn(ExperimentalAndroidComponentsApi::class)
internal class GeckoIPProtectionHandler(
    private val runtime: GeckoRuntime,
) : IPProtectionHandler {

    override fun activate() {
        runtime.ipProtectionController.activate()
    }

    override fun deactivate() {
        runtime.ipProtectionController.deactivate()
    }

    override fun enroll(onResult: (IPProtectionHandler.EnrollResult) -> Unit) {
        runtime.ipProtectionController.enroll().then(
            { result ->
                onResult(
                    IPProtectionHandler.EnrollResult(
                        isEnrolledAndEntitled = result?.isEnrolledAndEntitled == true,
                        error = result?.error,
                    ),
                )
                GeckoResult.fromValue(null)
            },
            { ex ->
                onResult(
                    IPProtectionHandler.EnrollResult(
                        isEnrolledAndEntitled = false,
                        error = ex.message,
                    ),
                )
                GeckoResult.fromValue(null)
            },
        )
    }

    override fun init() {
        runtime.ipProtectionController.init()
    }

    override fun setTokenProvider(
        provider: IPProtectionHandler.TokenProvider?,
        onInitialState: ((IPProtectionHandler.StateInfo) -> Unit)?,
    ) {
        // waiting for bug 2020725
    }
}
