/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.ui.efficiency.selectors

import mozilla.components.compose.browser.toolbar.concept.BrowserToolbarTestTags.ADDRESSBAR_SEARCH_BOX
import org.mozilla.fenix.ui.efficiency.helpers.Selector
import org.mozilla.fenix.ui.efficiency.helpers.SelectorStrategy

object BookmarkSearchSelectors {

    val SEARCH_BOX = Selector(
        strategy = SelectorStrategy.COMPOSE_BY_TAG,
        value = ADDRESSBAR_SEARCH_BOX,
        description = "Bookmark search box",
        groups = listOf("requiredForPage"),
    )

    val AWESOMEBAR_SUGGESTION = Selector(
        strategy = SelectorStrategy.COMPOSE_BY_TAG,
        value = "mozac.awesomebar.suggestion",
        description = "Awesomebar suggestion item",
        groups = listOf(),
    )

    val AWESOMEBAR_SUGGESTIONS_CONTAINER = Selector(
        strategy = SelectorStrategy.COMPOSE_BY_TAG,
        value = "mozac.awesomebar.suggestions",
        description = "Awesomebar suggestions container",
        groups = listOf(),
    )

    val all = listOf(
        SEARCH_BOX,
        AWESOMEBAR_SUGGESTION,
        AWESOMEBAR_SUGGESTIONS_CONTAINER,
    )
}
