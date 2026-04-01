package org.mozilla.fenix.tabgroups

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.tabstray.TabsTrayTestTag.BOTTOM_SHEET_COLOR_LIST
import org.mozilla.fenix.tabstray.data.TabGroupTheme
import org.mozilla.fenix.tabstray.redux.state.TabGroupFormState
import org.mozilla.fenix.tabstray.redux.state.TabsTrayState
import org.mozilla.fenix.tabstray.redux.store.TabsTrayStore
import org.mozilla.fenix.theme.FirefoxTheme
import org.mozilla.fenix.theme.Theme
import kotlin.test.assertEquals

@RunWith(AndroidJUnit4::class)
class EditTabGroupTest {
    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun `WHEN a color is clicked, THEN the form's state is updated`() {
        val store = TabsTrayStore(
            initialState = TabsTrayState(
                tabGroupFormState = fakeFormState(),
            ),
        )
        composeTestRule.setContent {
            ComposableUnderTest(store = store)
        }

        composeTestRule
            .onNodeWithTag("$BOTTOM_SHEET_COLOR_LIST.${TabGroupTheme.Green}")
            .performClick()

        composeTestRule.runOnIdle {
            assertEquals(store.state.tabGroupFormState?.theme, TabGroupTheme.Green)
        }
    }

    @Test
    fun `Verify all color items are placed`() {
        composeTestRule.setContent {
            ComposableUnderTest()
        }

        TabGroupTheme.entries.forEach { entry ->
            composeTestRule
                .onNodeWithTag("$BOTTOM_SHEET_COLOR_LIST.${entry.name}")
                .assertIsDisplayed()
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun ComposableUnderTest(
        store: TabsTrayStore = TabsTrayStore(
            initialState = TabsTrayState(
                tabGroupFormState = fakeFormState(),
            ),
        ),
    ) {
        val tabsTrayStore = remember {
            store
        }

        FirefoxTheme(theme = Theme.Light) {
            Surface {
                EditTabGroup(
                    tabsTrayStore = tabsTrayStore,
                )
            }
        }
    }

    private fun fakeFormState(): TabGroupFormState {
        return TabGroupFormState(
            tabGroupId = "123",
            name = "Test Group",
            nextTabGroupNumber = 1,
            theme = TabGroupTheme.Yellow,
            edited = false,
        )
    }
}
