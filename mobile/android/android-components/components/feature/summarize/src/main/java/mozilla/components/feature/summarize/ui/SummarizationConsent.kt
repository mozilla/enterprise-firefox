/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.summarize.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.PreviewLightDark
import androidx.compose.ui.unit.dp
import mozilla.components.compose.base.button.FilledButton
import mozilla.components.compose.base.theme.AcornTheme
import mozilla.components.feature.summarize.R
import mozilla.components.feature.summarize.SummarizationAction
import mozilla.components.feature.summarize.SummarizationAction.ConsentAction

/**
 * Composable to be rendered at the summarization consent state where we ask users if they
 * want to use the feature.
 */
@Composable
internal fun SummarizationConsent(
    modifier: Modifier = Modifier,
    dispatchAction: (SummarizationAction) -> Unit = {},
) {
    // TODO - we need to determine when to show:
    //  an on-device permission or remote permission.
    OnDeviceSummarizerConsent(
        modifier = modifier,
        onClickAllow = {
            dispatchAction(ConsentAction.AllowClicked)
        },
        onClickCancel = {
            dispatchAction(ConsentAction.CancelClicked)
        },
    )
}

@Composable
private fun OnDeviceSummarizerConsent(
    modifier: Modifier,
    onClickAllow: () -> Unit,
    onClickCancel: () -> Unit,
) {
    Column(modifier) {
        OnDeviceSummarizerContent()
        Spacer(modifier = Modifier.height(AcornTheme.layout.space.static300))
        OnDeviceSummarizerButtons(
            onClickAllow = onClickAllow,
            onClickCancel = onClickCancel,
        )
    }
}

@Composable
private fun OnDeviceSummarizerContent(modifier: Modifier = Modifier) {
    Column(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            text = stringResource(R.string.mozac_summarize_consent_title),
            style = AcornTheme.typography.headline6,
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
        )
        Spacer(modifier = Modifier.height(AcornTheme.layout.space.static100))
        Text(
            text = stringResource(R.string.mozac_summarize_consent_message_on_device),
            style = AcornTheme.typography.body2,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun OnDeviceSummarizerButtons(
    modifier: Modifier = Modifier,
    onClickAllow: () -> Unit,
    onClickCancel: () -> Unit,
) {
    Column(
        modifier = modifier,
    ) {
        FilledButton(
            modifier = Modifier.fillMaxWidth(),
            onClick = onClickAllow,
        ) {
            Text(text = stringResource(R.string.mozac_summarize_consent_button_positive_on_device))
        }
        Spacer(Modifier.height(AcornTheme.layout.space.static200))
        OutlinedButton(
            modifier = Modifier.fillMaxWidth(),
            onClick = onClickCancel,
        ) {
            Text(text = stringResource(R.string.mozac_summarize_consent_button_negative_on_device))
        }
    }
}

@PreviewLightDark
@Composable
private fun PreviewSummarizationConsent() = AcornTheme {
    Scaffold { paddingValues ->
        Box(
            modifier = Modifier
                .padding(paddingValues)
                .padding(16.dp)
                .fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            SummarizationConsent()
        }
    }
}
