/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabgroups

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.ForcedSize
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import mozilla.components.concept.engine.utils.ABOUT_HOME_URL
import org.junit.Assert
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.tabstray.TabsTrayTestTag
import org.mozilla.fenix.tabstray.data.TabGroupTheme
import org.mozilla.fenix.tabstray.data.TabsTrayItem
import org.mozilla.fenix.tabstray.data.createTab
import org.mozilla.fenix.tabstray.ui.tabitems.TabsTrayItemClickHandler
import org.mozilla.fenix.tabstray.ui.tabitems.TabsTrayItemSelectionState
import org.mozilla.fenix.theme.FirefoxTheme

@RunWith(AndroidJUnit4::class)
class TabGroupCardTest {
    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun verifyUIElementsPresent() {
        composeTestRule.setContent {
            FirefoxTheme {
                ComposableUnderTest()
            }
        }
        composeTestRule.onNodeWithTag(
            TabsTrayTestTag.TAB_GROUP_THREE_DOT_BUTTON,
            useUnmergedTree = true,
        ).assertIsDisplayed()
        composeTestRule.onNodeWithTag(
            TabsTrayTestTag.TAB_GROUP_THUMBNAIL_FIRST,
            useUnmergedTree = true,
        ).assertIsDisplayed()
        composeTestRule.onNodeWithTag(
            TabsTrayTestTag.TAB_GROUP_THUMBNAIL_SECOND,
            useUnmergedTree = true,
        ).assertIsDisplayed()
        composeTestRule.onNodeWithTag(
            TabsTrayTestTag.TAB_GROUP_THUMBNAIL_THIRD,
            useUnmergedTree = true,
        ).assertIsDisplayed()
        composeTestRule.onNodeWithTag(
            TabsTrayTestTag.TAB_GROUP_THUMBNAIL_FOURTH,
            useUnmergedTree = true,
        ).assertIsDisplayed()
    }

    @Test
    fun verifyClick() {
        var clicked = false
        var argumentReceived: String? = null
        composeTestRule.setContent {
            FirefoxTheme {
                ComposableUnderTest(
                    onClick = { arg ->
                        clicked = true
                        argumentReceived = arg
                    },
                )
            }
        }
        composeTestRule.onNodeWithTag(TabsTrayTestTag.TAB_ITEM_ROOT).performClick()
        Assert.assertTrue(clicked)
        Assert.assertEquals("Test", argumentReceived)
    }

    @Test
    fun verifyLongClick() {
        var longClicked = false
        var argumentReceived: String? = null
        composeTestRule.setContent {
            FirefoxTheme {
                ComposableUnderTest(
                    onLongClick = { arg ->
                        longClicked = true
                        argumentReceived = arg
                    },
                )
            }
        }
        composeTestRule.onNodeWithTag(TabsTrayTestTag.TAB_ITEM_ROOT).performTouchInput {
            longClick()
        }
        Assert.assertTrue(longClicked)
        Assert.assertEquals("Test", argumentReceived)
    }

    @Test
    fun verifyMenuItems() {
        composeTestRule.setContent {
            FirefoxTheme {
                ComposableUnderTest()
            }
        }
        composeTestRule.onNodeWithTag(TabsTrayTestTag.TAB_GROUP_THREE_DOT_BUTTON)
            .performClick()
        composeTestRule.onNodeWithTag(TabsTrayTestTag.EDIT_TAB_GROUP).assertIsDisplayed()
        composeTestRule.onNodeWithTag(TabsTrayTestTag.CLOSE_TAB_GROUP).assertIsDisplayed()
        composeTestRule.onNodeWithTag(TabsTrayTestTag.DELETE_TAB_GROUP).assertIsDisplayed()
    }

    @Test
    fun verifyThumbnailSizesSimilarOnSmallWindowPortrait() {
        composeTestRule.setContent {
            DeviceConfigurationOverride(DeviceConfigurationOverride.ForcedSize(DpSize(400.dp, 800.dp))) {
                FirefoxTheme {
                    ComposableUnderTest()
                }
            }
        }
        verifyThumbnailSizesSimilar()
    }

    @Test
    fun verifyThumbnailSizesSimilarOnSmallWindowLandscape() {
        composeTestRule.setContent {
            DeviceConfigurationOverride(DeviceConfigurationOverride.ForcedSize(DpSize(800.dp, 400.dp))) {
                FirefoxTheme {
                    ComposableUnderTest()
                }
            }
        }
        verifyThumbnailSizesSimilar()
    }

    @Test
    fun verifyThumbnailSizesSimilarOnLargeWindowPortrait() {
        composeTestRule.setContent {
            DeviceConfigurationOverride(DeviceConfigurationOverride.ForcedSize(DpSize(800.dp, 1280.dp))) {
                FirefoxTheme {
                    ComposableUnderTest()
                }
            }
        }
        verifyThumbnailSizesSimilar()
    }

    @Test
    fun verifyThumbnailSizesSimilarOnLargeWindowLandscape() {
        composeTestRule.setContent {
            DeviceConfigurationOverride(DeviceConfigurationOverride.ForcedSize(DpSize(1280.dp, 800.dp))) {
                FirefoxTheme {
                    ComposableUnderTest()
                }
            }
        }
        verifyThumbnailSizesSimilar()
    }

    private fun verifyThumbnailSizesSimilar() {
        val first = composeTestRule.onNodeWithTag(
            testTag = TabsTrayTestTag.TAB_GROUP_THUMBNAIL_FIRST,
            useUnmergedTree = true,
        ).fetchSemanticsNode().size
        val second = composeTestRule.onNodeWithTag(
            testTag = TabsTrayTestTag.TAB_GROUP_THUMBNAIL_SECOND,
            useUnmergedTree = true,
        ).fetchSemanticsNode().size
        val third = composeTestRule.onNodeWithTag(
            testTag = TabsTrayTestTag.TAB_GROUP_THUMBNAIL_THIRD,
            useUnmergedTree = true,
        ).fetchSemanticsNode().size
        val fourth = composeTestRule.onNodeWithTag(
            testTag = TabsTrayTestTag.TAB_GROUP_THUMBNAIL_FOURTH,
            useUnmergedTree = true,
        ).fetchSemanticsNode().size
        val thumbnails = listOf(first, second, third, fourth)
        val allowance = 10
        for (i in 1 until thumbnails.size) {
            assert(
                thumbnails[i].height in first.height - allowance..first.height + allowance,
                { "Height of thumbnail $i ${thumbnails[i].height} not within margin of error of ${first.height}" },
            )
            assert(
                thumbnails[i].width in first.width - allowance..first.width + allowance,
                { "Width of thumbnail $i ${thumbnails[i].width} not within margin of error of {${first.width}" },
            )
        }
    }

    @Composable
    private fun ComposableUnderTest(
        onClick: (String) -> Unit = {},
        onLongClick: (String) -> Unit = {},
    ) {
        TabGroupCard(
            group = TabsTrayItem.TabGroup(
                title = "Group 1",
                theme = TabGroupTheme.Yellow,
                tabs = hashSetOf(
                    createTab(
                        url = ABOUT_HOME_URL,
                    ),
                ),
            ),
            selectionState = TabsTrayItemSelectionState(),
            clickHandler = TabsTrayItemClickHandler(
                onClick = { onClick("Test") },
                onLongClick = { onLongClick("Test") },
                onCloseClick = {}, // Not implemented yet
            ),
        )
    }
}
