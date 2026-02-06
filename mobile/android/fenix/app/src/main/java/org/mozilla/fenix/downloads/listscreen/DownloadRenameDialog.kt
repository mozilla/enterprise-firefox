/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.downloads.listscreen

import androidx.annotation.VisibleForTesting
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import mozilla.components.compose.base.button.TextButton
import org.mozilla.fenix.R
import org.mozilla.fenix.downloads.listscreen.store.RenameFileError
import org.mozilla.fenix.theme.FirefoxTheme
import org.mozilla.fenix.theme.PreviewThemeProvider
import org.mozilla.fenix.theme.Theme
import org.mozilla.fenix.theme.ThemedValue
import org.mozilla.fenix.theme.ThemedValueProvider
import java.io.File
import mozilla.components.ui.icons.R as iconsR

/**
* This dialog is used to prompt the user to rename the downloaded file.
* It provides options to confirm or cancel the rename.
*
* @param originalFileName The original download file name to be renamed.
* @param onConfirmSave Callback invoked when the user confirms the rename.
* @param onCancel Callback invoked when the user cancels.
*/
@Composable
fun DownloadRenameDialog(
    originalFileName: String,
    onConfirmSave: (String) -> Unit,
    onCancel: () -> Unit,
) {
    var baseFileName by remember(originalFileName) {
        mutableStateOf(File(originalFileName).nameWithoutExtension)
    }
    val extensionWithDot = remember(originalFileName) {
        File(originalFileName).extension.takeIf { it.isNotEmpty() }?.let { ".$it" }
    }
    val newName by remember(baseFileName, extensionWithDot) {
        derivedStateOf { baseFileName.trim() + (extensionWithDot ?: "") }
    }

    AlertDialog(
        onDismissRequest = onCancel,
        title = {
            Text(
                text = stringResource(
                    R.string.download_rename_dialog_title,
                ),
                style = FirefoxTheme.typography.headline5,
            )
        },
        text = {
            OutlinedTextField(
                value = baseFileName,
                onValueChange = { baseFileName = it },
                label = {
                    Text(stringResource(R.string.download_rename_dialog_label))
                },
                suffix = {
                    extensionWithDot?.let { Text(text = it) }
                },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(DownloadsListTestTag.RENAME_DIALOG_TEXT_FIELD),
            )
        },
        confirmButton = {
            TextButton(
                text = stringResource(id = R.string.download_rename_dialog_confirm_button),
                enabled = enableConfirmButton(originalFileName, newName),
                onClick = { onConfirmSave(newName) },
                modifier = Modifier.testTag(
                    DownloadsListTestTag.RENAME_DIALOG_CONFIRM_BUTTON,
                ),
            )
        },
        dismissButton = {
            TextButton(
                text = stringResource(id = R.string.download_rename_dialog_cancel_button),
                onClick = onCancel,
                modifier = Modifier.testTag(
                    DownloadsListTestTag.RENAME_DIALOG_CANCEL_BUTTON,
                ),
            )
        },
    )
}

/**
 * This determines whether to enable the confirmation button, based on file
 * name validation such as if the new file name differs or if the new base
 * file name is not blank.
 *
 * @param originalFileName The original download file name to be renamed.
 * @param newFileName The proposed new file name.
 */
@VisibleForTesting
internal fun enableConfirmButton(
    originalFileName: String,
    newFileName: String,
): Boolean {
    val trimmed = newFileName.trim()

    if (trimmed.isEmpty() || trimmed == originalFileName) {
        return false
    }

    if (trimmed.contains("/") || trimmed.contains("\u0000")) {
        return false
    }

    val base = File(trimmed).nameWithoutExtension
    return base.isNotBlank()
}

@Composable
internal fun DownloadRenameErrorDialog(
    error: RenameFileError,
    onDismiss: () -> Unit,
) {
    val title = when (error) {
        is RenameFileError.NameAlreadyExists -> R.string.download_rename_error_exists_title
        RenameFileError.InvalidFileName -> R.string.download_rename_error_invalid_title
        RenameFileError.CannotRename -> R.string.download_rename_error_cannot_rename_title
    }

    val textRes = when (error) {
        is RenameFileError.NameAlreadyExists ->
            stringResource(
                R.string.download_rename_error_exists_description,
                error.proposedFileName,
            )
        RenameFileError.InvalidFileName -> stringResource(R.string.download_rename_error_invalid_description)
        RenameFileError.CannotRename -> stringResource(R.string.download_rename_error_cannot_rename_description)
    }

    AlertDialog(
        icon = {
            Icon(
                painter = painterResource(iconsR.drawable.mozac_ic_critical_24),
                contentDescription = null,
            )
        },
        title = {
            Text(
                text = stringResource(title),
                style = FirefoxTheme.typography.headline5,
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
            )
        },
        text = { Text(textRes) },
        confirmButton = {
            TextButton(
                text = stringResource(R.string.download_rename_error_dismiss_button),
                onClick = onDismiss,
                modifier = Modifier.testTag(
                    DownloadsListTestTag.RENAME_DIALOG_FAILURE_DISMISS_BUTTON,
                ),
            )
        },
        onDismissRequest = onDismiss,
    )
}

@Preview
@Composable
private fun RenameDownloadFileDialogPreview(
    @PreviewParameter(PreviewThemeProvider::class) theme: Theme,
) {
    FirefoxTheme(theme) {
        DownloadRenameDialog(
            originalFileName = "README.md",
            onConfirmSave = {},
            onCancel = {},
        )
    }
}

@Preview
@Composable
private fun RenameDownloadFileDialogMultipleExtensionsPreview(
    @PreviewParameter(PreviewThemeProvider::class) theme: Theme,
) {
    FirefoxTheme(theme) {
        DownloadRenameDialog(
            originalFileName = "original.test.name.jpg",
            onConfirmSave = {},
            onCancel = {},
        )
    }
}

@Preview
@Composable
private fun RenameDownloadFileDialogNoExtensionPreview(
    @PreviewParameter(PreviewThemeProvider::class) theme: Theme,
) {
    FirefoxTheme(theme) {
        DownloadRenameDialog(
            originalFileName = "file_with_no_extension",
            onConfirmSave = {},
            onCancel = {},
        )
    }
}

private data class RenameErrorPreviewState(
    val error: RenameFileError,
)

private class RenameErrorPreviewProvider : ThemedValueProvider<RenameErrorPreviewState>(
    sequenceOf(
        RenameErrorPreviewState(
            error = RenameFileError.NameAlreadyExists(proposedFileName = "original (1).pdf"),
        ),
        RenameErrorPreviewState(
            error = RenameFileError.InvalidFileName,
        ),
        RenameErrorPreviewState(
            error = RenameFileError.CannotRename,
        ),
    ),
)

@Preview
@Composable
private fun RenameDownloadFileErrorDialogsPreview(
    @PreviewParameter(RenameErrorPreviewProvider::class) state: ThemedValue<RenameErrorPreviewState>,
) {
    FirefoxTheme(state.theme) {
        DownloadRenameErrorDialog(
            error = state.value.error,
            onDismiss = {},
        )
    }
}
