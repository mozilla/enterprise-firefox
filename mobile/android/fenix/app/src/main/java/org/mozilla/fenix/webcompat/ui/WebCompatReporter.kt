/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.webcompat.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import mozilla.components.compose.base.LinkText
import mozilla.components.compose.base.LinkTextState
import mozilla.components.compose.base.button.FilledButton
import mozilla.components.compose.base.button.IconButton
import mozilla.components.compose.base.button.TextButton
import mozilla.components.compose.base.textfield.TextField
import mozilla.components.compose.base.theme.AcornCorners
import org.mozilla.fenix.Config
import org.mozilla.fenix.R
import org.mozilla.fenix.components.components
import org.mozilla.fenix.ext.getBaseDomainUrl
import org.mozilla.fenix.theme.FirefoxTheme
import org.mozilla.fenix.theme.ThemedValue
import org.mozilla.fenix.theme.ThemedValueProvider
import org.mozilla.fenix.webcompat.BrokenSiteReporterTestTags
import org.mozilla.fenix.webcompat.BrokenSiteReporterTestTags.BROKEN_SITE_REPORTER_DESCRIPTION_INPUT
import org.mozilla.fenix.webcompat.BrokenSiteReporterTestTags.BROKEN_SITE_REPORTER_SEND_BUTTON
import org.mozilla.fenix.webcompat.store.WebCompatReporterAction
import org.mozilla.fenix.webcompat.store.WebCompatReporterState
import org.mozilla.fenix.webcompat.store.WebCompatReporterState.BrokenSiteReason
import org.mozilla.fenix.webcompat.store.WebCompatReporterStore
import mozilla.components.ui.icons.R as iconsR

private const val PROBLEM_DESCRIPTION_MAX_LINES = 5

/**
 * Top-level UI for the Web Compat Reporter feature.
 *
 * @param store [WebCompatReporterStore] used to manage the state of the Web Compat Reporter feature.
 */
@Suppress("LongMethod")
@Composable
fun WebCompatReporter(
    store: WebCompatReporterStore,
) {
    val state by store.stateFlow.collectAsState()

    var previewSheetVisible by remember { mutableStateOf(false) }

    val scrollState = rememberScrollState()

    var baseDomain by remember { mutableStateOf("") }

    val appComponents = components

    LaunchedEffect(state.enteredUrl) {
        baseDomain = if (state.enteredUrl.isNotEmpty()) {
            state.enteredUrl.getBaseDomainUrl(
                publicSuffixList = appComponents.publicSuffixList,
            )
        } else {
            ""
        }
    }

    BackHandler {
        store.dispatch(WebCompatReporterAction.BackPressed)
    }

    Scaffold(
        topBar = {
            TempAppBar(
                onBackClick = {
                    store.dispatch(WebCompatReporterAction.BackPressed)
                },
                scrollState = scrollState,
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .verticalScroll(scrollState)
                .padding(paddingValues)
                .imePadding()
                .padding(horizontal = 16.dp, vertical = 12.dp)
                .width(FirefoxTheme.layout.size.containerMaxWidth),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            ReadOnlyUrlField(
                url = state.enteredUrl,
                label = stringResource(id = R.string.webcompat_reporter_label_url),
                onClick = {
                    store.dispatch(WebCompatReporterAction.EditUrlClicked)
                },
                modifier = Modifier.fillMaxWidth(),
                baseDomain = baseDomain,
            )

            Spacer(modifier = Modifier.height(FirefoxTheme.layout.space.static200))

            HorizontalDivider()

            Spacer(modifier = Modifier.height(FirefoxTheme.layout.space.static200))

            BrokenSiteReasonSection(
                selectedReason = state.reason,
                onReasonSelected = { reason ->
                    store.dispatch(WebCompatReporterAction.ReasonChanged(reason))
                },
                onReasonCleared = {
                    store.dispatch(WebCompatReporterAction.ReasonCleared)
                },
            )

            if (state.reason != null) {
                Spacer(modifier = Modifier.height(FirefoxTheme.layout.space.static150))

                ProblemDescriptionInput(
                    problemDescription = state.problemDescription,
                    hasDescriptionError = state.hasDescriptionError,
                    onDescriptionChanged = { newText ->
                        store.dispatch(WebCompatReporterAction.ProblemDescriptionChanged(newText))
                    },
                )

                Spacer(modifier = Modifier.height(16.dp))

                Row(
                    modifier = Modifier
                        .toggleable(
                            value = state.includeEtpBlockedUrls,
                            role = Role.Checkbox,
                            onValueChange = { isChecked ->
                                store.dispatch(
                                    WebCompatReporterAction.IncludeEtpBlockedUrlsChanged(
                                        include = isChecked,
                                    ),
                                )
                            },
                        )
                        .padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(
                        checked = state.includeEtpBlockedUrls,
                        onCheckedChange = null,
                        modifier = Modifier,
                    )

                    Spacer(modifier = Modifier.width(16.dp))

                    Column {
                        Text(
                            text = stringResource(id = R.string.webcompat_reporter_etp_checkbox_text_2),
                            color = MaterialTheme.colorScheme.onSurface,
                            style = FirefoxTheme.typography.body1,
                        )
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                TextButton(
                    text = stringResource(id = R.string.webcompat_reporter_preview_report),
                    modifier = Modifier
                        .fillMaxWidth(),
                    onClick = {
                        previewSheetVisible = true
                        store.dispatch(WebCompatReporterAction.OpenPreviewClicked)
                    },
                )
            }

            Spacer(modifier = Modifier.height(16.dp))

            FilledButton(
                text = stringResource(id = R.string.webcompat_reporter_send),
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics {
                        testTagsAsResourceId = true
                        testTag = BROKEN_SITE_REPORTER_SEND_BUTTON
                    },
                enabled = state.isSubmitEnabled,
            ) {
                store.dispatch(WebCompatReporterAction.SendReportClicked)
            }

            Spacer(modifier = Modifier.height(16.dp))

            TextButton(
                text = stringResource(id = R.string.webcompat_reporter_cancel),
                modifier = Modifier
                    .fillMaxWidth(),
                onClick = {
                    store.dispatch(WebCompatReporterAction.CancelClicked)
                },
            )

            // Note: the "Add more info" button is not meant for Release, so we're only
            // enabling it in Beta and Nightly/Debug
            if (Config.channel.isBeta || Config.channel.isNightlyOrDebug) {
                Spacer(modifier = Modifier.height(16.dp))

                Text(
                    text = stringResource(id = R.string.webcompat_reporter_add_more_info),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            store.dispatch(WebCompatReporterAction.AddMoreInfoClicked)
                        },
                    style = FirefoxTheme.typography.body2.copy(textAlign = TextAlign.Center),
                    color = MaterialTheme.colorScheme.tertiary,
                    textDecoration = TextDecoration.Underline,
                )
            }

            Spacer(modifier = Modifier.height(FirefoxTheme.layout.space.static150))

            LinkText(
                text = stringResource(
                    R.string.webcompat_reporter_description_3,
                    stringResource(R.string.app_name),
                    stringResource(R.string.webcompat_reporter_learn_more),
                ),
                linkTextStates = listOf(
                    LinkTextState(
                        text = stringResource(R.string.webcompat_reporter_learn_more),
                        url = "",
                        onClick = {
                            store.dispatch(WebCompatReporterAction.LearnMoreClicked)
                        },
                    ),
                ),
                style = FirefoxTheme.typography.body2.copy(color = MaterialTheme.colorScheme.onSurfaceVariant),
                linkTextColor = MaterialTheme.colorScheme.primary,
                linkTextDecoration = TextDecoration.None,
                textAlign = TextAlign.Start,
                modifier = Modifier.padding(bottom = FirefoxTheme.layout.space.static150),
            )
        }
    }

    if (state.showEditUrlDialog) {
        EditUrlConfirmationDialog(
            url = state.editedUrl,
            onUrlChange = { newUrl -> store.dispatch(WebCompatReporterAction.EditUrlChanged(newUrl = newUrl)) },
            isError = state.hasEditedUrlError,
            onSave = { store.dispatch(WebCompatReporterAction.SaveEditedUrlClicked) },
            onDismiss = { store.dispatch(WebCompatReporterAction.DismissEditUrlDialog) },
        )
    }

    if (previewSheetVisible) {
        WebCompatReporterPreviewSheet(
            previewJSON = state.previewJSON,
            onDismissRequest = { previewSheetVisible = false },
            onSendClick = { store.dispatch(WebCompatReporterAction.SendReportClicked) },
            isSendButtonEnabled = state.isSubmitEnabled,
        )
    }
}

@Composable
private fun ProblemDescriptionInput(
    problemDescription: String,
    hasDescriptionError: Boolean,
    onDescriptionChanged: (String) -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = stringResource(id = R.string.webcompat_reporter_label_description_2),
            style = FirefoxTheme.typography.headline7,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier
                .fillMaxWidth()
                .padding(
                    start = FirefoxTheme.layout.space.static50,
                    bottom = FirefoxTheme.layout.space.static100,
                    end = FirefoxTheme.layout.space.static50,
                ),
        )

        TextField(
            value = problemDescription,
            onValueChange = onDescriptionChanged,
            placeholder = stringResource(id = R.string.webcompat_reporter_problem_description_placeholder_text_2),
            errorText = stringResource(id = R.string.webcompat_reporter_description_error),
            isError = hasDescriptionError,
            singleLine = false,
            maxLines = PROBLEM_DESCRIPTION_MAX_LINES,
            modifier = Modifier
                .fillMaxWidth()
                .height(225.dp)
                .semantics {
                    testTagsAsResourceId = true
                    testTag = BROKEN_SITE_REPORTER_DESCRIPTION_INPUT
                },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TempAppBar(
    onBackClick: () -> Unit,
    scrollState: ScrollState,
) {
    TopAppBar(
        title = {
            Text(
                text = stringResource(id = R.string.webcompat_reporter_screen_title),
                style = FirefoxTheme.typography.headline5,
            )
        },
        navigationIcon = {
            IconButton(
                onClick = onBackClick,
                contentDescription = stringResource(R.string.bookmark_navigate_back_button_content_description),
            ) {
                Icon(
                    painter = painterResource(iconsR.drawable.mozac_ic_back_24),
                    contentDescription = null,
                )
            }
        },
        windowInsets = WindowInsets(
            top = 0.dp,
            bottom = 0.dp,
        ),
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = if (scrollState.canScrollBackward) {
                MaterialTheme.colorScheme.surfaceContainerHigh
            } else {
                MaterialTheme.colorScheme.surface
            },
        ),
    )
}

@Composable
private fun BrokenSiteReasonSection(
    selectedReason: BrokenSiteReason?,
    onReasonSelected: (BrokenSiteReason) -> Unit,
    onReasonCleared: () -> Unit,
) {
    Text(
        text = stringResource(id = R.string.webcompat_reporter_label_whats_broken_3),
        style = FirefoxTheme.typography.headline7,
        color = MaterialTheme.colorScheme.onSurface,
        modifier = Modifier.fillMaxWidth(),
    )

    Spacer(modifier = Modifier.height(FirefoxTheme.layout.space.static100))

    if (selectedReason == null) {
        BrokenSiteReasonList(
            onReasonSelected = onReasonSelected,
        )
    } else {
        BrokenSiteReasonListItem(
            text = stringResource(selectedReason.displayStringId),
            shape = RoundedCornerShape(AcornCorners.extraLarge), // Kept this rounded!
            modifier = Modifier.testTag(BrokenSiteReporterTestTags.BROKEN_SITE_REPORTER_SELECTED_REASON),
            onClick = null,
            iconPainter = painterResource(id = iconsR.drawable.mozac_ic_cross_circle_24),
            iconDescription = stringResource(R.string.webcompat_reporter_clear_reason_content_description),
            onIconClick = onReasonCleared,
        )
    }
}

@Composable
private fun BrokenSiteReasonList(
    onReasonSelected: (BrokenSiteReason) -> Unit,
) {
    val reasons = BrokenSiteReason.entries
    val outerCornerRadius = AcornCorners.extraLarge
    val middleCornerRadius = AcornCorners.extraSmall

    Column(
        verticalArrangement = Arrangement.spacedBy(FirefoxTheme.layout.space.static25),
    ) {
        reasons.forEachIndexed { index, reason ->
            BrokenSiteReasonListItem(
                text = stringResource(reason.displayStringId),
                shape = getReasonListItemShape(
                    index = index,
                    lastIndex = reasons.lastIndex,
                    outerCornerRadius = outerCornerRadius,
                    middleCornerRadius = middleCornerRadius,
                ),
                onClick = {
                    onReasonSelected(reason)
                },
            )
        }
    }
}

/**
 * Helper that returns the shape for a broken site reason list item based on its position in the list.
 *
 * The first item receives rounded top corners, the last item receives rounded bottom corners,
 * middle items receive a smaller rounded shape, and a single item receives rounded corners on all
 * sides.
 *
 * @param index The position of the item in the reason list.
 * @param lastIndex The index of the last item in the reason list.
 * @param outerCornerRadius The corner radius used for the outer edges of the first and last items.
 * @param middleCornerRadius The corner radius used for items between the first and last items.
 * @return The [Shape] to apply to the reason list item.
 */
private fun getReasonListItemShape(
    index: Int,
    lastIndex: Int,
    outerCornerRadius: Dp,
    middleCornerRadius: Dp,
): Shape {
    return when {
        lastIndex == 0 -> RoundedCornerShape(outerCornerRadius)

        index == 0 -> RoundedCornerShape(
            topStart = outerCornerRadius,
            topEnd = outerCornerRadius,
        )

        index == lastIndex -> RoundedCornerShape(
            bottomStart = outerCornerRadius,
            bottomEnd = outerCornerRadius,
        )

        else -> RoundedCornerShape(middleCornerRadius)
    }
}

private class WebCompatPreviewParameterProvider : ThemedValueProvider<WebCompatReporterState>(
    sequenceOf(
        // Initial feature opening
        WebCompatReporterState(
            enteredUrl = "www.example.com/url_parameters_that_break_the_page",
        ),
        // Error in URL field
        WebCompatReporterState(
            enteredUrl = "",
        ),
        // Multi-line description
        WebCompatReporterState(
            enteredUrl = "www.example.com/url_parameters_that_break_the_page",
            reason = BrokenSiteReason.Slow,
            problemDescription = "The site wouldn’t load and after I tried xyz it still wouldn’t " +
                    "load and then again site wouldn’t load and after I tried xyz it still wouldn’t " +
                    "load and then again site wouldn’t load and after I tried xyz it still wouldn’t " +
                    "load and then again site wouldn’t load and after I tried xyz it still wouldn’t " +
                    "load and then again site wouldn’t load and after I tried xyz it still wouldn’t " +
                    "load and then again ",
        ),
    ),
)

@Preview
@Composable
private fun WebCompatReporterPreview(
    @PreviewParameter(WebCompatPreviewParameterProvider::class) state: ThemedValue<WebCompatReporterState>,
) {
    FirefoxTheme(state.theme) {
        WebCompatReporter(
            store = WebCompatReporterStore(
                initialState = state.value,
            ),
        )
    }
}
