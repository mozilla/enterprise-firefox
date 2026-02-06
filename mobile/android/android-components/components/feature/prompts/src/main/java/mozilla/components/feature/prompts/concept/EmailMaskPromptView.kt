/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.prompts.concept

/**
 * A prompt for displaying an email mask.
 */
interface EmailMaskPromptView : ToggleablePrompt {

    /**
     * Listener for user interactions with the prompt.
     */
    var emailMaskPromptListener: Listener?

    /**
     * Interface to allow a class to listen to email mask event events.
     */
    interface Listener {
        /**
         * Called when a user clicks on the email mask prompt.
         */
        fun onEmailMaskPromptClick()
    }
}
