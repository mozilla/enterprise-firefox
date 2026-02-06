/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.prompts.emailmask

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.PreviewLightDark
import androidx.compose.ui.unit.dp
import mozilla.components.compose.base.theme.AcornTheme
import mozilla.components.feature.prompts.R
import mozilla.components.ui.icons.R as iconsR

/**
 * A bar for displaying email mask related actions.
 *
 * @param onMaskEmailClicked a mask email chip click listener.
 */
@Composable
fun EmailMaskPromptBar(
    onMaskEmailClicked: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface {
        Row(
            modifier = modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
        ) {
            MaskEmailChip(
                onClick = onMaskEmailClicked,
            )
        }
    }
}

@Composable
private fun MaskEmailChip(
    onClick: () -> Unit,
) {
    Surface(
        modifier = Modifier
            .clickable(onClick = onClick)
            .minimumInteractiveComponentSize(),
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.primaryContainer,
    ) {
        Row(
            modifier = Modifier
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                painter = painterResource(id = iconsR.drawable.mozac_ic_mask_email_24),
                contentDescription = null, // talkback should focus on the whole element
                modifier = Modifier.size(16.dp),
            )

            Spacer(modifier = Modifier.size(8.dp))

            Text(
                text = stringResource(id = R.string.mozac_feature_relay_chip_text),
                style = AcornTheme.typography.headline8,
            )
        }
    }
}

@PreviewLightDark
@Composable
private fun EmailMaskPromptBarPreview() {
    AcornTheme {
        EmailMaskPromptBar(
            onMaskEmailClicked = {},
        )
    }
}
