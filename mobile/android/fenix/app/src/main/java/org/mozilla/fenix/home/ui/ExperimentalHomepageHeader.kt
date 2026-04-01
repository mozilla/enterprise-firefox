/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.home.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.mozilla.fenix.R
import org.mozilla.fenix.home.ui.HomepageTestTag.PRIVATE_BROWSING_HOMEPAGE_BUTTON
import org.mozilla.fenix.theme.FirefoxTheme
import org.mozilla.fenix.theme.PreviewThemeProvider
import org.mozilla.fenix.theme.Theme
import mozilla.components.ui.icons.R as iconsR

private const val NEWS_BUTTON_ANIMATION_TRANSITION_DURATION = 600
private const val NEWS_BUTTON_ANIMATION_DURATION = 2000L
private const val NEWS_BUTTON_ANIMATION_DELAY = 500L

/**
 * Homepage header for the entry points experiment.
 *
 * @param wordmarkTextColor color for the wordmark.
 * @param showNewsAnimation Whether to animate the news label on the stories button.
 * @param onPrivateModeTapped callback for when the private mode button is tapped.
 * @param onStoriesTapped callback for when the stories button is tapped.
 * @param onNewsAnimationShown callback invoked when the news button animation starts playing.
 * @param onLogoClicked callback for when the logo is clicked
 */
@Composable
fun ExperimentalHomepageHeader(
    wordmarkTextColor: Color?,
    showNewsAnimation: Boolean,
    onPrivateModeTapped: () -> Unit,
    onStoriesTapped: () -> Unit,
    onNewsAnimationShown: () -> Unit,
    onLogoClicked: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .wrapContentHeight()
            .padding(all = 16.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        PrivateModeButton(onPrivateModeTapped)

        Column {
            Spacer(modifier = Modifier.height(28.dp))
            WordmarkAndLogo(
                wordmarkTextColor = wordmarkTextColor,
                onLogoClicked = onLogoClicked,
            )
        }

        StoriesButton(
            onClick = onStoriesTapped,
            showNewsAnimation = showNewsAnimation,
            onNewsAnimationShown = onNewsAnimationShown,
        )
    }
}

/**
 * Homepage header for the entry points experiment in private mode.
 *
 * @param onHomeTapped callback for when the home button is tapped.
 */
@Composable
fun ExperimentalPrivateHomepageHeader(onHomeTapped: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .wrapContentHeight()
            .padding(all = 16.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.End,
    ) {
        HomeButton(onHomeTapped)
    }
}

@Composable
private fun WordmarkAndLogo(
    wordmarkTextColor: Color?,
    modifier: Modifier = Modifier,
    onLogoClicked: () -> Unit,
) {
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WordmarkLogo(onLogoClicked)
        WordmarkText(wordmarkTextColor)
    }
}

@Composable
private fun PrivateModeButton(onClick: () -> Unit) {
    LeftChevronPillButton(
        onClick = onClick,
        modifier = Modifier.semantics {
            testTagsAsResourceId = true
            testTag = PRIVATE_BROWSING_HOMEPAGE_BUTTON
        },
    ) {
        Icon(
            painter = painterResource(iconsR.drawable.mozac_ic_private_mode_24),
            contentDescription = stringResource(R.string.content_description_private_browsing),
        )
    }
}

@Composable
private fun StoriesButton(
    onClick: () -> Unit,
    showNewsAnimation: Boolean,
    onNewsAnimationShown: () -> Unit,
) {
    var visible by remember { mutableStateOf(false) }

    LaunchedEffect(showNewsAnimation) {
        if (showNewsAnimation) {
            delay(NEWS_BUTTON_ANIMATION_DELAY)
            visible = true
            delay(NEWS_BUTTON_ANIMATION_DURATION)
            onNewsAnimationShown()
            visible = false
        }
    }

    RightChevronPillButton(onClick = onClick) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(FirefoxTheme.layout.space.static50),
        ) {
            Icon(
                painter = painterResource(iconsR.drawable.mozac_ic_reading_list_24),
                contentDescription = stringResource(R.string.homepage_all_stories),
            )

            AnimatedVisibility(
                visible = visible,
                enter = fadeIn(animationSpec = tween(durationMillis = NEWS_BUTTON_ANIMATION_TRANSITION_DURATION)),
                exit = fadeOut(animationSpec = tween(durationMillis = NEWS_BUTTON_ANIMATION_TRANSITION_DURATION)),
            ) {
                Text(
                    text = stringResource(R.string.stories_screen_text_news),
                    style = FirefoxTheme.typography.body2,
                    modifier = Modifier.padding(start = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun HomeButton(onClick: () -> Unit) {
    RightChevronPillButton(
        onClick = onClick,
        border = BorderStroke(width = 1.dp, color = MaterialTheme.colorScheme.outlineVariant),
    ) {
        Icon(
            painter = painterResource(iconsR.drawable.mozac_ic_home_24),
            contentDescription = stringResource(R.string.content_description_normal_browsing),
        )
    }
}

@Preview
@Composable
private fun HomepageHeaderPreview(
    @PreviewParameter(PreviewThemeProvider::class) theme: Theme,
) {
    FirefoxTheme(theme) {
        Surface {
            ExperimentalHomepageHeader(
                wordmarkTextColor = null,
                showNewsAnimation = false,
                onPrivateModeTapped = {},
                onStoriesTapped = {},
                onNewsAnimationShown = {},
                onLogoClicked = {},
            )
        }
    }
}

@Preview
@Composable
private fun PrivateHomepageHeaderPreview(
    @PreviewParameter(PreviewThemeProvider::class) theme: Theme,
) {
    FirefoxTheme(theme) {
        Surface {
            ExperimentalPrivateHomepageHeader {}
        }
    }
}
