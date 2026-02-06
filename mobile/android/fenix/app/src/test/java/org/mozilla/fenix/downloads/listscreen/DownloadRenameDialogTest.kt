package org.mozilla.fenix.downloads.listscreen

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import junit.framework.TestCase.assertFalse
import junit.framework.TestCase.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.downloads.listscreen.store.RenameFileError

@RunWith(AndroidJUnit4::class)
class DownloadRenameDialogTest {
    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun `GIVEN changed filename WHEN checking confirm button THEN button is enabled`() {
        val result = enableConfirmButton(
            originalFileName = "document.pdf",
            newFileName = "new_document.pdf",
        )

        assertTrue(result)
    }

    @Test
    fun `GIVEN only extension changed WHEN checking confirm button THEN button is enabled`() {
        val result = enableConfirmButton(
            originalFileName = "document.pdf",
            newFileName = "document.txt",
        )

        assertTrue(result)
    }

    @Test
    fun `GIVEN unchanged filename WHEN checking confirm button THEN button is disabled`() {
        val result = enableConfirmButton(
            originalFileName = "document.pdf",
            newFileName = "document.pdf",
        )

        assertFalse(result)
    }

    @Test
    fun `GIVEN blank filename WHEN checking confirm button THEN button is disabled`() {
        val result = enableConfirmButton(
            originalFileName = "document.pdf",
            newFileName = "",
        )

        assertFalse(result)
    }

    @Test
    fun `GIVEN whitespace only filename WHEN checking confirm button THEN button is disabled`() {
        val result = enableConfirmButton(
            originalFileName = "document.pdf",
            newFileName = "   ",
        )

        assertFalse(result)
    }

    @Test
    fun `GIVEN blank base name with extension WHEN checking confirm button THEN button is disabled`() {
        val result = enableConfirmButton(
            originalFileName = "document.pdf",
            newFileName = ".pdf",
        )

        assertFalse(result)
    }

    fun `GIVEN filename containing slash WHEN checking confirm button THEN button is disabled`() {
        val result = enableConfirmButton(
            originalFileName = "document.pdf",
            newFileName = "doc/ument.pdf",
        )

        assertFalse(result)
    }

    fun `GIVEN filename containing NUL WHEN checking confirm button THEN button is disabled`() {
        val result = enableConfirmButton(
            originalFileName = "document.pdf",
            newFileName = "doc\u0000ument.pdf",
        )

        assertFalse(result)
    }

    @Test
    fun `GIVEN a valid file name change WHEN clicking confirm button THEN onConfirmSave is called `() {
        var confirmedName: String? = null
        var cancelled = false

        composeTestRule.setContent {
            DownloadRenameDialog(
                originalFileName = "original.pdf",
                onConfirmSave = { confirmedName = it },
                onCancel = { cancelled = true },
            )
        }

        composeTestRule
            .onNodeWithTag(DownloadsListTestTag.RENAME_DIALOG_TEXT_FIELD)
            .performTextReplacement("renamed")

        composeTestRule
            .onNodeWithTag(DownloadsListTestTag.RENAME_DIALOG_CONFIRM_BUTTON)
            .assertIsEnabled()
            .performClick()

        composeTestRule.runOnIdle {
            assertFalse(cancelled)
            assertEquals("renamed.pdf", confirmedName)
        }
    }

    @Test
    fun `GIVEN the rename dialog is show WHEN cancel is clicked THEN onCancel is called`() {
        var cancelled = false

        composeTestRule.setContent {
            DownloadRenameDialog(
                originalFileName = "original.pdf",
                onConfirmSave = {},
                onCancel = { cancelled = true },
            )
        }

        composeTestRule
            .onNodeWithTag(DownloadsListTestTag.RENAME_DIALOG_CANCEL_BUTTON)
            .performClick()

        composeTestRule.runOnIdle {
            assertTrue(cancelled)
        }
    }

    @Test
    fun `GIVEN rename error dialog NameAlreadyExists WHEN shown THEN proposed filename is displayed`() {
        val proposed = "original (1).pdf"

        composeTestRule.setContent {
            DownloadRenameErrorDialog(
                error = RenameFileError.NameAlreadyExists(proposedFileName = proposed),
                onDismiss = {},
            )
        }

        composeTestRule
            .onNodeWithText(proposed, substring = true)
            .assertIsDisplayed()
    }

    @Test
    fun `GIVEN rename error dialog WHEN OK clicked THEN onDismiss is called`() {
        var dismissed = false

        composeTestRule.setContent {
            DownloadRenameErrorDialog(
                error = RenameFileError.NameAlreadyExists(proposedFileName = "original (1).pdf"),
                onDismiss = { dismissed = true },
            )
        }

        composeTestRule
            .onNodeWithTag(DownloadsListTestTag.RENAME_DIALOG_FAILURE_DISMISS_BUTTON)
            .performClick()

        composeTestRule.runOnIdle {
            assertTrue(dismissed)
        }
    }
}
