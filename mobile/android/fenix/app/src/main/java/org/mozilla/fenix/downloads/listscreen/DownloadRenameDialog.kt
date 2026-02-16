/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.downloads.listscreen

import androidx.annotation.VisibleForTesting
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import org.mozilla.fenix.theme.ThemedValue
import org.mozilla.fenix.theme.ThemedValueProvider
import java.io.File
import mozilla.components.ui.icons.R as iconsR

/**
* This dialog is used to prompt the user to rename the downloaded file.
* It provides options to confirm or cancel the rename.
*
* @param originalFileName The original download file name to be renamed.
* @param error The [RenameFileError] shown if there is a renaming error.
* @param onConfirmSave Callback invoked when the user confirms the rename.
* @param onCancel Callback invoked when the user cancels.
* @param onCannotRenameDismiss Callback invoked when the user dismisses Cannot Rename failure.
*/
@Composable
fun DownloadRenameDialog(
    originalFileName: String,
    error: RenameFileError? = null,
    onConfirmSave: (String) -> Unit,
    onCancel: () -> Unit,
    onCannotRenameDismiss: () -> Unit,
) {
    var baseFileName by remember(originalFileName) {
        mutableStateOf(File(originalFileName).nameWithoutExtension)
    }
    val extensionWithDot = remember(originalFileName) {
        File(originalFileName).extension.takeIf { it.isNotEmpty() }?.let { ".$it" }
    }

    val currentError: RenameFileError? = when {
        baseFileName.contains("/") -> RenameFileError.InvalidFileName
        error is RenameFileError.NameAlreadyExists &&
                error.proposedFileName == baseFileName + extensionWithDot -> error
        else -> null
    }

    AlertDialog(
        onDismissRequest = onCancel,
        title = {
            Text(
                text = stringResource(R.string.download_rename_dialog_title),
                style = FirefoxTheme.typography.headline5,
            )
        },
        text = {
            DownloadRenameDialogTextField(
                baseFileName = baseFileName,
                onBaseFileNameChange = { updated ->
                    baseFileName = updated
                },
                extensionWithDot = extensionWithDot,
                currentError = currentError,
            )
        },
        confirmButton = {
            val newName = baseFileName.trim() + (extensionWithDot ?: "")
            TextButton(
                text = stringResource(id = R.string.download_rename_dialog_confirm_button),
                enabled = enableConfirmButton(originalFileName, newName, currentError),
                onClick = { onConfirmSave(newName) },
                modifier = Modifier.testTag(DownloadsListTestTag.RENAME_DIALOG_CONFIRM_BUTTON),
            )
        },
        dismissButton = {
            TextButton(
                text = stringResource(id = R.string.download_rename_dialog_cancel_button),
                onClick = onCancel,
                modifier = Modifier.testTag(DownloadsListTestTag.RENAME_DIALOG_CANCEL_BUTTON),
            )
        },
    )

    if (error == RenameFileError.CannotRename) {
        DownloadCannotRenameDialog(onDismiss = onCannotRenameDismiss)
    }
}

@Composable
private fun DownloadRenameDialogTextField(
    baseFileName: String,
    onBaseFileNameChange: (String) -> Unit,
    extensionWithDot: String?,
    currentError: RenameFileError?,
    modifier: Modifier = Modifier,
) {
    val errorTextResource = when (currentError) {
        is RenameFileError.InvalidFileName ->
            stringResource(R.string.download_rename_error_invalid_name_error)
        is RenameFileError.NameAlreadyExists ->
            stringResource(
                R.string.download_rename_error_exists_error,
                currentError.proposedFileName,
            )
        else -> null
    }

    OutlinedTextField(
        value = baseFileName,
        onValueChange = onBaseFileNameChange,
        label = { Text(stringResource(R.string.download_rename_dialog_label)) },
        suffix = { extensionWithDot?.let { Text(text = it) } },
        isError = currentError != null,
        supportingText = errorTextResource?.let {
            {
                Text(
                    text = it,
                    style = FirefoxTheme.typography.caption,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        },
        singleLine = true,
        modifier = modifier
            .fillMaxWidth()
            .testTag(DownloadsListTestTag.RENAME_DIALOG_TEXT_FIELD),
    )
}

/**
 * This determines whether to enable the confirmation button, based on file
 * name validation such as if the new file name differs or if the new base
 * file name is not blank.
 *
 * @param originalFileName The original download file to be renamed.
 * @param newFileName The proposed new file name.
 * @param currentError The current error in the text field.
 */
@VisibleForTesting
internal fun enableConfirmButton(
    originalFileName: String,
    newFileName: String,
    currentError: RenameFileError? = null,
): Boolean {
    val trimmed = newFileName.trim()

    val isInvalidRename =
        currentError != null ||
        trimmed.isEmpty() ||
        trimmed == originalFileName ||
        '/' in trimmed ||
        '\u0000' in trimmed
    if (isInvalidRename) return false

    val base = File(trimmed).nameWithoutExtension
    return base.isNotBlank()
}

@Composable
private fun DownloadCannotRenameDialog(
    onDismiss: () -> Unit,
) {
    AlertDialog(
        icon = {
            Icon(
                painter = painterResource(iconsR.drawable.mozac_ic_critical_24),
                contentDescription = null,
            )
        },
        title = {
            Text(
                text = stringResource(R.string.download_rename_error_cannot_rename_title),
                style = FirefoxTheme.typography.headline5,
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
            )
        },
        text = { Text(stringResource(R.string.download_rename_error_cannot_rename_description)) },
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

private data class RenameDialogPreviewState(
    val originalFileName: String,
    val error: RenameFileError? = null,
)

private class RenameDialogPreviewProvider : ThemedValueProvider<RenameDialogPreviewState>(
    sequenceOf(
        RenameDialogPreviewState(
            originalFileName = "README.md",
        ),
        RenameDialogPreviewState(
            originalFileName = "original.test.name.jpg",
        ),
        RenameDialogPreviewState(
            originalFileName = "file_with_no_extension",
        ),
        RenameDialogPreviewState(
            originalFileName = "README(2).md",
            error = RenameFileError.NameAlreadyExists(proposedFileName = "README(2).md"),
        ),
        RenameDialogPreviewState(
            originalFileName = "README.md",
            error = RenameFileError.CannotRename,
        ),
    ),
)

@Preview
@Composable
private fun RenameDownloadFileDialogPreview(
    @PreviewParameter(RenameDialogPreviewProvider::class) state: ThemedValue<RenameDialogPreviewState>,
) {
    FirefoxTheme(state.theme) {
        DownloadRenameDialog(
            originalFileName = state.value.originalFileName,
            error = state.value.error,
            onConfirmSave = {},
            onCancel = {},
            onCannotRenameDismiss = {},
        )
    }
}
