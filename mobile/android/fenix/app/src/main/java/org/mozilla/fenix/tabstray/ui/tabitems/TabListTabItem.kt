/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.ui.tabitems

import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.core.DecayAnimationSpec
import androidx.compose.animation.rememberSplineBasedDecay
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.PreviewLightDark
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.tooling.preview.PreviewParameterProvider
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import mozilla.components.compose.base.RadioCheckmark
import mozilla.components.support.base.utils.MAX_URI_LENGTH
import org.mozilla.fenix.R
import org.mozilla.fenix.compose.DismissibleItemBackground
import org.mozilla.fenix.compose.SwipeToDismissBox2
import org.mozilla.fenix.compose.SwipeToDismissState2
import org.mozilla.fenix.compose.TabThumbnail
import org.mozilla.fenix.ext.toShortUrl
import org.mozilla.fenix.tabstray.TabsTrayTestTag
import org.mozilla.fenix.tabstray.data.TabsTrayItem
import org.mozilla.fenix.tabstray.data.createTab
import org.mozilla.fenix.theme.FirefoxTheme
import mozilla.components.browser.tabstray.R as tabstrayR
import mozilla.components.ui.icons.R as iconsR

private val ThumbnailWidth = 78.dp
private val ThumbnailHeight = 68.dp

/**
 * List item used to display a tab that supports clicks,
 * long clicks, multiselection, and media controls.
 *
 * @param tab The given tab to render as list item.
 * @param modifier [Modifier] to be applied to the tab list item content.
 * @param isSelected Indicates if the item should be rendered as selected.
 * @param multiSelectionEnabled Indicates if the item should be rendered with multi selection options,
 * enabled.
 * @param multiSelectionSelected Indicates if the item should be rendered as multi selection selected
 * option.
 * @param shouldClickListen Whether the item should stop listening to click events.
 * @param swipingEnabled Whether the item is swipeable.
 * @param onCloseClick Invoked when the close button is clicked.
 * @param onClick Invoked when the item is clicked.
 * @param onLongClick Invoked when the item is long clicked.
 */
@Composable
fun TabListTabItem(
    tab: TabsTrayItem.Tab,
    modifier: Modifier = Modifier,
    isSelected: Boolean = false,
    multiSelectionEnabled: Boolean = false,
    multiSelectionSelected: Boolean = false,
    shouldClickListen: Boolean = true,
    swipingEnabled: Boolean = true,
    onCloseClick: (TabsTrayItem.Tab) -> Unit,
    onClick: (TabsTrayItem) -> Unit,
    onLongClick: ((TabsTrayItem) -> Unit)? = null,
) {
    val decayAnimationSpec: DecayAnimationSpec<Float> = rememberSplineBasedDecay()
    val density = LocalDensity.current
    val isRtl = LocalLayoutDirection.current == LayoutDirection.Rtl

    val swipeState = remember(multiSelectionEnabled, swipingEnabled) {
        SwipeToDismissState2(
            density = density,
            enabled = !multiSelectionEnabled && swipingEnabled,
            decayAnimationSpec = decayAnimationSpec,
            isRtl = isRtl,
        )
    }

    SwipeToDismissBox2(
        state = swipeState,
        onItemDismiss = {
            onCloseClick(tab)
        },
        backgroundContent = {
            DismissibleItemBackground(
                isSwipeActive = swipeState.swipingActive,
                isSwipingToStart = swipeState.swipingActive && swipeState.isSwipingToStart,
            )
        },
    ) {
        TabContent(
            tab = tab,
            selectionState = TabsTrayItemSelectionState(
                isSelected = multiSelectionSelected,
                isFocused = isSelected,
                multiSelectEnabled = multiSelectionEnabled,
            ),
            shouldClickListen = shouldClickListen,
            modifier = modifier,
            onCloseClick = onCloseClick,
            onClick = onClick,
            onLongClick = onLongClick,
        )
    }
}

@Suppress("LongParameterList")
@Composable
private fun TabContent(
    tab: TabsTrayItem.Tab,
    selectionState: TabsTrayItemSelectionState,
    shouldClickListen: Boolean,
    modifier: Modifier = Modifier,
    onCloseClick: (TabsTrayItem.Tab) -> Unit,
    onClick: (TabsTrayItem) -> Unit,
    onLongClick: ((TabsTrayItem) -> Unit)? = null,
) {
    val contentBackgroundColor = if (selectionState.isFocused) {
        MaterialTheme.colorScheme.primaryContainer
    } else if (selectionState.isSelected) {
        MaterialTheme.colorScheme.surfaceContainerHigh
    } else {
        MaterialTheme.colorScheme.surfaceContainerLowest
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(contentBackgroundColor)
            .tabItemClickable(
                clickHandler = TabsTrayItemClickHandler(
                    enabled = shouldClickListen,
                    onClick = onClick,
                    onLongClick = onLongClick,
                ),
                clickedItem = tab,
            )
            .padding(start = 16.dp, top = 8.dp, bottom = 8.dp)
            .testTag(TabsTrayTestTag.TAB_ITEM_ROOT)
            .semantics {
                selected = selectionState.isFocused
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Thumbnail(tab = tab)

        Column(
            modifier = Modifier
                .padding(start = 16.dp)
                .weight(weight = 1f),
        ) {
            Text(
                text = tab.title.take(MAX_URI_LENGTH),
                color = MaterialTheme.colorScheme.onSurface,
                style = FirefoxTheme.typography.body1,
                overflow = TextOverflow.Ellipsis,
                maxLines = 2,
            )

            Text(
                text = tab.url.toShortUrl(),
                color = MaterialTheme.colorScheme.secondary,
                style = FirefoxTheme.typography.body2,
                overflow = TextOverflow.Ellipsis,
                maxLines = 1,
            )
        }

        if (!selectionState.multiSelectEnabled) {
            IconButton(
                onClick = { onCloseClick(tab) },
                modifier = Modifier
                    .size(size = 48.dp)
                    .testTag(TabsTrayTestTag.TAB_ITEM_CLOSE),
            ) {
                Icon(
                    painter = painterResource(id = iconsR.drawable.mozac_ic_cross_24),
                    contentDescription = stringResource(
                        id = R.string.close_tab_title,
                        tab.title,
                    ),
                    tint = MaterialTheme.colorScheme.secondary,
                )
            }
        } else {
            RadioCheckmark(
                isSelected = selectionState.isSelected,
                modifier = Modifier.padding(end = 16.dp),
            )
        }
    }
}

@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
private fun Thumbnail(
    tab: TabsTrayItem.Tab,
) {
    val density = LocalDensity.current
    val thumbnailSize = with(density) { ThumbnailWidth.toPx() }.toInt()
    TabThumbnail(
        tabThumbnailImageData = tab.toThumbnailImageData(),
        thumbnailSizePx = thumbnailSize,
        modifier = Modifier
            .size(
                width = ThumbnailWidth,
                height = ThumbnailHeight,
            )
            .testTag(TabsTrayTestTag.TAB_ITEM_THUMBNAIL),
        shape = RoundedCornerShape(size = 4.dp),
        border = BorderStroke(width = 1.dp, color = MaterialTheme.colorScheme.outlineVariant),
        contentDescription = stringResource(id = tabstrayR.string.mozac_browser_tabstray_open_tab),
    )
}

private data class TabListItemPreviewState(
    val isSelected: Boolean,
    val multiSelectionEnabled: Boolean,
    val multiSelectionSelected: Boolean,
    val url: String = "www.mozilla.org",
    val title: String = "Mozilla Domain",
)

private class TabListItemParameterProvider : PreviewParameterProvider<TabListItemPreviewState> {
    override val values: Sequence<TabListItemPreviewState>
        get() = sequenceOf(
            TabListItemPreviewState(
                isSelected = false,
                multiSelectionEnabled = false,
                multiSelectionSelected = false,
            ),
            TabListItemPreviewState(
                isSelected = true,
                multiSelectionEnabled = false,
                multiSelectionSelected = false,
            ),
            TabListItemPreviewState(
                isSelected = false,
                multiSelectionEnabled = true,
                multiSelectionSelected = false,
            ),
            TabListItemPreviewState(
                isSelected = true,
                multiSelectionEnabled = true,
                multiSelectionSelected = false,
            ),
            TabListItemPreviewState(
                isSelected = false,
                multiSelectionEnabled = true,
                multiSelectionSelected = true,
            ),
            TabListItemPreviewState(
                isSelected = true,
                multiSelectionEnabled = true,
                multiSelectionSelected = true,
            ),
            TabListItemPreviewState(
                isSelected = false,
                multiSelectionEnabled = false,
                multiSelectionSelected = false,
                url = "www.google.com/superlongurl",
                title = "Super super super super super super super super long title",
            ),
        )
}

@Composable
@PreviewLightDark
private fun TabListTabItemPreview(
    @PreviewParameter(TabListItemParameterProvider::class) tabListItemState: TabListItemPreviewState,
) {
    FirefoxTheme {
        TabListTabItem(
            tab = createTab(
                url = tabListItemState.url,
                title = tabListItemState.title,
            ),
            isSelected = tabListItemState.isSelected,
            onCloseClick = {},
            onClick = {},
            multiSelectionEnabled = tabListItemState.multiSelectionEnabled,
            multiSelectionSelected = tabListItemState.multiSelectionSelected,
        )
    }
}
