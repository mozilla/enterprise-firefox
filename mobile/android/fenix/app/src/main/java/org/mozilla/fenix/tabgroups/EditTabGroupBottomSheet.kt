/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabgroups

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SheetState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.tooling.preview.PreviewLightDark
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.tooling.preview.PreviewParameterProvider
import androidx.compose.ui.unit.dp
import mozilla.components.compose.base.annotation.FlexibleWindowPreview
import mozilla.components.compose.base.button.TextButton
import mozilla.components.compose.base.theme.AcornTheme
import org.mozilla.fenix.R
import org.mozilla.fenix.compose.BottomSheetHandle
import org.mozilla.fenix.tabstray.redux.action.TabGroupAction
import org.mozilla.fenix.tabstray.redux.state.TabGroupFormState
import org.mozilla.fenix.tabstray.redux.state.TabsTrayState
import org.mozilla.fenix.tabstray.redux.store.TabsTrayStore
import org.mozilla.fenix.theme.FirefoxTheme
import org.mozilla.fenix.theme.PreviewThemeProvider
import org.mozilla.fenix.theme.Theme

private const val BOTTOM_SHEET_HANDLER_ALPHA = 0.4F
private val formFieldShape = RoundedCornerShape(16.dp)

/**
 * Prompt to edit a tab group.
 *
 * @param tabsTrayStore [TabsTrayStore] used to listen for changes to
 * [TabsTrayState].
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditTabGroupBottomSheet(
    tabsTrayStore: TabsTrayStore,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    val formState by tabsTrayStore.tabGroupFormStateFlow.collectAsState(
        initial = tabsTrayStore.state.tabGroupFormState ?: return,
    )

    LaunchedEffect(Unit) {
        if (!sheetState.isVisible) {
            sheetState.show()
        }
    }

    BottomSheet(
        sheetState = sheetState,
        formState = formState,
        onTabGroupNameChange = { newName ->
            tabsTrayStore.dispatch(TabGroupAction.NameChanged(newName))
        },
        onDismissRequest = {
            tabsTrayStore.dispatch(TabGroupAction.FormDismissed)
        },
        onConfirmSave = {
            tabsTrayStore.dispatch(TabGroupAction.SaveClicked)
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BottomSheet(
    sheetState: SheetState,
    formState: TabGroupFormState,
    onTabGroupNameChange: (String) -> Unit,
    onDismissRequest: () -> Unit,
    onConfirmSave: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismissRequest,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
        dragHandle = {
            BottomSheetHandle(
                onRequestDismiss = onDismissRequest,
                contentDescription = stringResource(R.string.edit_tab_group_bottom_sheet_close_content_description),
                modifier = Modifier.padding(all = 16.dp).alpha(BOTTOM_SHEET_HANDLER_ALPHA),
            )
        },
    ) {
        EditTabGroupContent(
            formState = formState,
            onTabGroupNameChange = onTabGroupNameChange,
            onConfirmSave = onConfirmSave,
        )
    }
}

@Composable
private fun EditTabGroupContent(
    formState: TabGroupFormState,
    onTabGroupNameChange: (String) -> Unit,
    onConfirmSave: () -> Unit,
) {
    val title =
        if (formState.inEditState) {
            stringResource(R.string.edit_tab_group_title)
        } else {
            stringResource(R.string.create_tab_group_title)
        }

    val defaultName = stringResource(
        R.string.create_tab_group_form_default_name,
        formState.nextTabGroupNumber,
    )
    val initialName = formState.getInitialName(defaultName)

    var tabGroupName by remember {
        mutableStateOf(
            TextFieldValue(
                text = initialName,
                selection = TextRange(0, initialName.length),
            ),
        )
    }

    Column(
        modifier = Modifier.padding(bottom = 12.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(
                    horizontal = AcornTheme.layout.space.dynamic200,
                    vertical = AcornTheme.layout.space.static150,
                ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = title,
                modifier = Modifier.weight(1f).padding(start = 24.dp),
                style = FirefoxTheme.typography.headline7,
            )

            TextButton(
                text = stringResource(R.string.create_tab_group_save_button),
                onClick = onConfirmSave,
                modifier = Modifier.padding(end = 12.dp),
            )
        }

        Surface(
            shape = formFieldShape,
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = AcornTheme.layout.space.dynamic200),
        ) {
            TabGroupNameTextField(
                tabGroupName = tabGroupName,
                onTabGroupNameChange = { newName ->
                    tabGroupName = newName
                    onTabGroupNameChange(newName.text)
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp, vertical = 16.dp),
            )
        }
    }
}

@Composable
private fun TabGroupNameTextField(
    tabGroupName: TextFieldValue,
    onTabGroupNameChange: (TextFieldValue) -> Unit,
    modifier: Modifier = Modifier,
) {
    val focusRequester = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        focusRequester.requestFocus()
    }

    val selectionColors = TextSelectionColors(
        handleColor = LocalTextSelectionColors.current.handleColor,
        backgroundColor = MaterialTheme.colorScheme.primaryContainer,
    )

    OutlinedTextField(
        value = tabGroupName,
        onValueChange = onTabGroupNameChange,
        label = {
            Text(
                text = stringResource(R.string.create_tab_group_name_label),
                style = FirefoxTheme.typography.caption,
            )
        },
        singleLine = true,
        modifier = modifier.focusRequester(focusRequester),
        colors = OutlinedTextFieldDefaults.colors(
            selectionColors = selectionColors,
        ),
    )
}

private class TabGroupFormStateParameterProvider : PreviewParameterProvider<TabGroupFormState> {
    val data = listOf(
        Pair(
            "Create tab group",
            TabGroupFormState(
                tabGroupId = null,
                name = "",
                nextTabGroupNumber = 1,
                edited = false,
            ),
        ),
        Pair(
            "Edit tab group",
            TabGroupFormState(
                tabGroupId = "1",
                name = "Test group",
                edited = false,
            ),
        ),
        Pair(
            "Edit tab group with blank name",
            TabGroupFormState(
                tabGroupId = "1",
                name = "",
                edited = true,
            ),
        ),
    )

    override fun getDisplayName(index: Int): String {
        return data[index].first
    }

    override val values: Sequence<TabGroupFormState>
        get() = data.map { it.second }.asSequence()
}

@PreviewLightDark
@Composable
private fun EditTabGroupContentPreview(
    @PreviewParameter(TabGroupFormStateParameterProvider::class) formState: TabGroupFormState,
) {
    FirefoxTheme {
        Surface {
            EditTabGroupContent(
                formState = formState,
                onConfirmSave = {},
                onTabGroupNameChange = {},
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@FlexibleWindowPreview
@Composable
private fun EditTabGroupBottomSheetPreview(
    @PreviewParameter(PreviewThemeProvider::class) theme: Theme,
) {
    val tabsTrayStore = remember {
        TabsTrayStore(
            initialState = TabsTrayState(
                tabGroupFormState = TabGroupFormState(
                    tabGroupId = null,
                    name = "",
                    nextTabGroupNumber = 1,
                    edited = false,
                ),
            ),
        )
    }

    FirefoxTheme(theme) {
        EditTabGroupBottomSheet(tabsTrayStore = tabsTrayStore)
    }
}
