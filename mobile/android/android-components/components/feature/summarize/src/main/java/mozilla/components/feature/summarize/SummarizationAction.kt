/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.summarize

import mozilla.components.lib.state.Action

/**
 * Actions for the [SummarizationStore]
 */
internal interface SummarizationAction : Action {

    /**
     * Actions for the consent step of summarization user flow
     */
    sealed interface ConsentAction : SummarizationAction {

        /**
         * Action to indicate the user has accepted the consent and allowed summarization
         */
        data object AllowClicked : ConsentAction

        /**
         * Action to indicate the user has canceled the consent and disallowed summarization
         */
        data object CancelClicked : ConsentAction
    }
}
