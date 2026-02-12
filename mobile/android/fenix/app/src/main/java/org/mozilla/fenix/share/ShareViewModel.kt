/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.share

import android.content.Context
import android.content.Intent
import android.content.pm.ResolveInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkRequest
import androidx.annotation.VisibleForTesting
import androidx.appcompat.content.res.AppCompatResources
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import mozilla.components.concept.sync.DeviceCapability
import mozilla.components.feature.share.RecentAppsStorage
import mozilla.components.service.fxa.manager.FxaAccountManager
import mozilla.components.support.utils.ext.packageManagerCompatHelper
import org.mozilla.fenix.R
import org.mozilla.fenix.ext.isOnline
import org.mozilla.fenix.share.DefaultShareController.Companion.ACTION_COPY_LINK_TO_CLIPBOARD
import org.mozilla.fenix.share.listadapters.AppShareOption
import org.mozilla.fenix.share.listadapters.SyncShareOption

/**
 * [androidx.lifecycle.ViewModel] responsible for managing the data required for the Share functionality.
 *
 * This class handles the logic for:
 * - Fetching and filtering the list of installed applications that can handle share intents.
 * - Retrieving synchronized devices from the Firefox Account (Fxa) to enable "Send to Device".
 * - Managing "recent apps" storage to provide quick-access share targets.
 * - Monitoring network connectivity to update the availability of sync-related share options.
 *
 * @param fxaAccountManager Manager for Firefox Account operations and device constellation data.
 * @param recentAppsStorage Storage for keeping track of frequently used share targets.
 * @param connectivityManager System service for monitoring network state changes.
 * @param ioDispatcher The [CoroutineDispatcher] used for background operations.
 */
class ShareViewModel(
    private val fxaAccountManager: FxaAccountManager,
    private val recentAppsStorage: RecentAppsStorage,
    private val connectivityManager: ConnectivityManager?,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {
    companion object {
        internal const val RECENT_APPS_LIMIT = 6
    }

    /**
     * Represents the state of the Share UI, containing the data to be displayed in the share sheet.
     *
     * @property devices The list of synchronized devices or account-related actions (e.g., Sign In).
     * @property recentApps The list of frequently used applications for sharing.
     * @property otherApps The list of all other available applications and system actions (e.g., Copy Link).
     * @property isLoading Whether the initial data load for the share sheet is in progress.
     */
    data class ShareUiState(
        val devices: List<SyncShareOption> = emptyList(),
        val recentApps: List<AppShareOption> = emptyList(),
        val otherApps: List<AppShareOption> = emptyList(),
        val isLoading: Boolean = false,
    )

    private val _uiState = MutableStateFlow(ShareUiState(isLoading = true))
    val uiState: StateFlow<ShareUiState> = _uiState.asStateFlow()

    private var isNetworkCallbackRegistered = false
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onLost(network: Network) = refreshDevices(network)
        override fun onAvailable(network: Network) = refreshDevices(network)
    }

    /**
     * Initializes the data loading process for the share sheet.
     *
     * Once the data is retrieved, it updates the [_uiState] with the recent apps, other available
     * apps, and synchronized devices, and sets the loading state to false.
     *
     * @param context The Android context used to query package information and load resources.
     */
    internal fun initDataLoad(context: Context) {
        if (!isNetworkCallbackRegistered) {
            val networkRequest = NetworkRequest.Builder().build()
            connectivityManager?.registerNetworkCallback(networkRequest, networkCallback)
            isNetworkCallbackRegistered = true
        }

        viewModelScope.launch {
            // Run apps loading and device loading in parallel
            val appsDeferred = async { loadAppsWorkflow(context) }
            val devicesDeferred = async { buildDeviceList() }

            val (recent, apps) = appsDeferred.await()
            _uiState.update {
                it.copy(
                    recentApps = recent,
                    otherApps = apps,
                    devices = devicesDeferred.await(),
                    isLoading = false,
                )
            }
        }
    }

    private suspend fun loadAppsWorkflow(context: Context): Pair<List<AppShareOption>, List<AppShareOption>> =
        withContext(ioDispatcher) {
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
            }

            val resolveInfos = getIntentActivities(shareIntent, context)
            val allApps = buildAppsList(resolveInfos, context)

            // Update DB
            recentAppsStorage.updateDatabaseWithNewApps(allApps.map { it.activityName })

            val recentApps = fetchRecentApps(allApps)
            val recentNames = recentApps.map { it.activityName }.toSet()

            // Filter out recents and prepend Copy action
            val otherApps = mutableListOf<AppShareOption>().apply {
                getCopyApp(context)?.let { add(it) }
                addAll(allApps.filterNot { it.activityName in recentNames })
            }

            return@withContext Pair(recentApps, otherApps)
        }

    private fun refreshDevices(network: Network?) {
        viewModelScope.launch {
            // Trigger FxA refresh
            fxaAccountManager.authenticatedAccount()
                ?.deviceConstellation()
                ?.refreshDevices()

            val devices = buildDeviceList(network)
            _uiState.update { it.copy(devices = devices) }
        }
    }

    private fun fetchRecentApps(allApps: List<AppShareOption>): List<AppShareOption> {
        val recentRecords = recentAppsStorage.getRecentAppsUpTo(RECENT_APPS_LIMIT)
        val appsMap = allApps.associateBy { it.activityName }
        return recentRecords.mapNotNull { appsMap[it.activityName] }
    }

    override fun onCleared() {
        if (isNetworkCallbackRegistered) {
            connectivityManager?.unregisterNetworkCallback(networkCallback)
        }
    }

    private fun getCopyApp(context: Context): AppShareOption? {
        val copyIcon = AppCompatResources.getDrawable(context, R.drawable.ic_share_clipboard)

        return copyIcon?.let {
            AppShareOption(
                context.getString(R.string.share_copy_link_to_clipboard),
                copyIcon,
                ACTION_COPY_LINK_TO_CLIPBOARD,
                "",
            )
        }
    }

    internal suspend fun getIntentActivities(
        shareIntent: Intent,
        context: Context,
    ): List<ResolveInfo> = withContext(ioDispatcher) {
        context.packageManagerCompatHelper.queryIntentActivitiesCompat(shareIntent, 0).orEmpty()
    }

    /**
     * Returns a list of apps that can be shared to.
     *
     * @param intentActivities List of activities from [getIntentActivities].
     * @param context Android context.
     */
    @VisibleForTesting
    internal suspend fun buildAppsList(
        intentActivities: List<ResolveInfo>?,
        context: Context,
    ): List<AppShareOption> = withContext(ioDispatcher) {
        intentActivities
            .orEmpty()
            .filter { it.activityInfo.packageName != context.packageName }
            .map { resolveInfo ->
                AppShareOption(
                    resolveInfo.loadLabel(context.packageManager).toString(),
                    resolveInfo.loadIcon(context.packageManager),
                    resolveInfo.activityInfo.packageName,
                    resolveInfo.activityInfo.name,
                )
            }
    }

    /**
     * Builds list of options to display in the top row of the share sheet.
     * This will primarily include devices that tabs can be sent to, but also options
     * for reconnecting the account or sending to all devices.
     */
    @VisibleForTesting
    internal suspend fun buildDeviceList(network: Network? = null): List<SyncShareOption> =
        withContext(ioDispatcher) {
            val account = fxaAccountManager.authenticatedAccount()
            when {
                // No network
                isOffline(network) -> listOf(SyncShareOption.Offline)
                // No account signed in
                account == null -> listOf(SyncShareOption.SignIn)
                // Account needs to be re-authenticated
                fxaAccountManager.accountNeedsReauth() -> listOf(SyncShareOption.Reconnect)
                // Signed in
                else -> {
                    val shareableDevices = account.deviceConstellation().state()
                        ?.otherDevices
                        .orEmpty()
                        .filter { it.capabilities.contains(DeviceCapability.SEND_TAB) }
                        .sortedByDescending { it.lastAccessTime }

                    val list = mutableListOf<SyncShareOption>()
                    if (shareableDevices.isEmpty()) {
                        // Show add device button if there are no devices
                        list.add(SyncShareOption.AddNewDevice)
                    }

                    shareableDevices.mapTo(list) { SyncShareOption.SingleDevice(it) }

                    if (shareableDevices.size > 1) {
                        // Show send all button if there are multiple devices
                        list.add(SyncShareOption.SendAll(shareableDevices))
                    }
                    list
                }
            }
        }

    /**
     * Checks if the network is offline.
     *
     * @param network The network to check. If null, the default active network is checked.
     * @return `true` if `connectivityManager` is null (unable to determine network state) or if
     *   `isOnline(network)` returns false (explicitly offline).
     */
    @VisibleForTesting
    internal fun isOffline(network: Network?): Boolean =
        connectivityManager?.isOnline(network) != true
}
