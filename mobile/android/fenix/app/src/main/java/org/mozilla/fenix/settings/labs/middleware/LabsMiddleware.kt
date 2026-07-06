/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings.labs.middleware

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import mozilla.components.concept.base.crash.Breadcrumb
import mozilla.components.concept.base.crash.CrashReporting
import mozilla.components.lib.state.Middleware
import mozilla.components.lib.state.Store
import mozilla.components.service.nimbus.NimbusApi
import mozilla.components.support.base.log.logger.Logger
import org.mozilla.fenix.settings.labs.LabsItem
import org.mozilla.fenix.settings.labs.nimbus.EnrollmentResult
import org.mozilla.fenix.settings.labs.nimbus.toEnrollmentResult
import org.mozilla.fenix.settings.labs.nimbus.toLabsItem
import org.mozilla.fenix.settings.labs.store.LabsAction
import org.mozilla.fenix.settings.labs.store.LabsState
import org.mozilla.fenix.utils.Settings

private val logger = Logger("LabsMiddleware")

/**
 * [Middleware] implementation for handling [LabsAction] and managing the [LabsState] for the
 * Firefox Labs screen.
 *
 * @param context The [Context] used to resolve string resources.
 * @param settings An instance of [Settings] to read and write to the [SharedPreferences]
 * properties.
 * @param nimbusSdk The [NimbusApi] used to fetch available Firefox Labs opt-ins from Nimbus.
 * @param onRestart Callback invoked to restart the application.
 * @param onOpenFeedback Callback invoked to open a Labs item's feedback URL.
 * @param crashReporter [CrashReporting] instance used for recording caught exceptions.
 * @param scope [CoroutineScope] used to launch coroutines.
 */
class LabsMiddleware(
    private val context: Context,
    private val settings: Settings,
    private val nimbusSdk: NimbusApi,
    private val onRestart: () -> Unit,
    private val onOpenFeedback: (String) -> Unit,
    private val crashReporter: CrashReporting? = null,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO),
) : Middleware<LabsState, LabsAction> {

    override fun invoke(
        store: Store<LabsState, LabsAction>,
        next: (LabsAction) -> Unit,
        action: LabsAction,
    ) {
        when (action) {
            is LabsAction.InitAction -> initialize(store = store)
            is LabsAction.RefreshLabs -> refreshLabs(store = store)
            is LabsAction.RestartApplication -> restartApplication()
            is LabsAction.RestoreDefaults -> restoreDefaults(store = store)
            is LabsAction.ToggleLabsItem -> toggleLabsItem(
                store = store,
                item = action.item,
            )
            is LabsAction.ShareFeedbackClicked -> {
                action.item.feedbackUrl?.let(onOpenFeedback)
            }
            else -> Unit
        }

        next(action)
    }

    private fun initialize(
        store: Store<LabsState, LabsAction>,
    ) = scope.launch {
        store.dispatch(LabsAction.UpdateLabsItems(fetchLabs()))
    }

    private fun toggleLabsItem(
        store: Store<LabsState, LabsAction>,
        item: LabsItem,
    ) = scope.launch {
        when (setItemEnrolled(slug = item.slug, enrolled = !item.enrolled)) {
            EnrollmentResult.Success -> if (item.requiresRestart) {
                store.dispatch(LabsAction.RestartApplication)
            } else {
                // Toggling a Lab can make sibling Labs that share an underlying feature unavailable. Refetch
                // so those items are deactivated in place.
                refreshLabs(store = store)
            }
            // The toggle didn't take effect in Nimbus, so we need to refetch the state.
            EnrollmentResult.Failed -> refreshLabs(store = store)
            // The Labs item was removed as an option after we fetched the store, just remove it as an option.
            EnrollmentResult.Invalid -> store.dispatch(LabsAction.RemoveLabsItem(slug = item.slug))
        }
    }

    @Suppress("TooGenericExceptionCaught")
    private fun restoreDefaults(
        store: Store<LabsState, LabsAction>,
    ) = scope.launch {
        val anyRequiresRestart = store.state.labsItems.any { it.enrolled && it.requiresRestart }

        try {
            nimbusSdk.unenrollFromAllFirefoxLabs().await()
            if (anyRequiresRestart) {
                store.dispatch(LabsAction.RestartApplication)
            }
        } catch (e: Exception) {
            val message = "Failed to unenroll from all Firefox Labs"
            logger.warn(message, e)
            crashReporter?.recordCrashBreadcrumb(Breadcrumb(message = message))
            crashReporter?.submitCaughtException(e)
            initialize(store = store)
        }
    }

    /**
     * Applies the enrollment change in Nimbus and maps the outcome to how the screen
     * should handle the response.
     *
     * @return
     * [EnrollmentResult.Success] - enrollment proceeded as expected
     * [EnrollmentResult.Failed] - enrollment failed due to any reason, refetch states
     * [EnrollmentResult.Invalid] - enrollment item no longer exists, remove item from list
     */
    @Suppress("TooGenericExceptionCaught")
    private suspend fun setItemEnrolled(slug: String, enrolled: Boolean): EnrollmentResult {
        return try {
            if (enrolled) {
                nimbusSdk.enrollInFirefoxLab(slug).await().toEnrollmentResult()
            } else {
                nimbusSdk.unenrollFromFirefoxLab(slug).await().toEnrollmentResult()
            }
        } catch (e: Exception) {
            val message = "Failed to set enrollment for Firefox Lab '$slug'"
            logger.warn(message, e)
            crashReporter?.recordCrashBreadcrumb(Breadcrumb(message = message))
            crashReporter?.submitCaughtException(e)
            EnrollmentResult.Failed
        }
    }

    private fun restartApplication() = scope.launch {
        settings.preferences.edit {
            commit()
        }
        onRestart()
    }

    /**
     * Fetches the currently available Firefox Labs from Nimbus, sorted by slug.
     *
     * @return The available Labs as [LabsItem]s, or an empty list if the fetch fails.
     */
    @Suppress("TooGenericExceptionCaught")
    private suspend fun fetchLabs(): List<LabsItem> {
        return try {
            nimbusSdk.getAvailableFirefoxLabs().await()
                .mapNotNull { it.toLabsItem(context) }
                .sortedBy { it.slug }
        } catch (e: Exception) {
            val message = "Failed to fetch Firefox Labs from Nimbus"
            logger.warn(message, e)
            crashReporter?.recordCrashBreadcrumb(Breadcrumb(message = message))
            crashReporter?.submitCaughtException(e)
            emptyList()
        }
    }

    /**
     * Refetches Labs and reconciles them with what is on screen so Labs that became unavailable
     * are deactivated in place rather than disappearing. Will set the items on the store.
     *
     * @param store The [Store] whose displayed Labs are refreshed and updated.
     */
    private fun refreshLabs(
        store: Store<LabsState, LabsAction>,
    ) = scope.launch {
        val latest = fetchLabs()
        val merged = mergeLabsConflicts(
            displayed = store.state.labsItems,
            latest = latest,
        )
        store.dispatch(LabsAction.UpdateLabsItems(merged))
    }

    /**
     * Reconciles the currently [displayed] Labs with the freshly fetched [latest] ones so that
     * Labs no longer on offer are deactivated in place.
     *
     * @param displayed The currently visible Labs on screen.
     * @param latest The newest freshly fetched Labs from Nimbus.
     *
     * @return A list of Labs, sorted by slug, where each displayed item shows its latest state, or
     * is deactivated if it is no longer offered, plus any Labs that have newly become available.
     */
    private fun mergeLabsConflicts(
        displayed: List<LabsItem>,
        latest: List<LabsItem>,
    ): List<LabsItem> {
        val latestBySlug = latest.associateBy { it.slug }

        // Show the latest version of each Lab still on offer, and deactivate the rest as conflicts.
        val reconciled = displayed.map { displayedItem ->
            val latestVersion = latestBySlug[displayedItem.slug]
            if (latestVersion == null) {
                displayedItem.copy(enrolled = false, available = false)
            } else {
                latestVersion
            }
        }

        // Append any Labs that became available since the screen was last loaded.
        val displayedSlugs = displayed.map { it.slug }.toSet()
        val newlyAvailable = latest.filter { it.slug !in displayedSlugs }

        return (reconciled + newlyAvailable).sortedBy { it.slug }
    }
}
