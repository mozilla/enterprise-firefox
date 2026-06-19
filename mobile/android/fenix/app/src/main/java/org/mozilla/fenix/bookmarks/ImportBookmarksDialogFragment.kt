/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.bookmarks

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.DialogFragment
import androidx.fragment.compose.content
import mozilla.appservices.places.BookmarkRoot
import mozilla.components.concept.bookmark.parser.BookmarksFileParser
import mozilla.components.concept.bookmarks.file.BookmarksFileImporter
import mozilla.components.feature.importer.BookmarkImporter
import mozilla.components.feature.importer.ImporterEvent
import mozilla.components.lib.bookmark.parser.jsoup.jsoupParser
import mozilla.components.lib.bookmarks.file.htmlImporter
import org.mozilla.fenix.R
import org.mozilla.fenix.ext.requireComponents

internal class ImportBookmarksDialogFragment : DialogFragment() {
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View = content {
        BookmarkImporter(
            importer = BookmarksFileImporter.htmlImporter(
                context = requireContext(),
                parentGuid = BookmarkRoot.Mobile.id,
                parser = BookmarksFileParser.jsoupParser(
                    rootFolderName = requireContext().getString(R.string.bookmark_import_destination_default_name),
                ),
                inserter = requireComponents.core.bookmarksStorage,
            ),
            onEventReceived = { event ->
                parentFragmentManager.setFragmentResult(
                    REQUEST_KEY,
                    Bundle().apply { putString(KEY_IMPORT_EVENT, event.encode()) },
                )
                dismissWhenFinished(event)
            },
        )
    }

    private fun dismissWhenFinished(event: ImporterEvent) {
        if (event !is ImporterEvent.Started) {
            dismiss()
        }
    }

    companion object {
        const val REQUEST_KEY = "import_bookmarks_request"
        const val KEY_IMPORT_EVENT = "event"
        internal const val IMPORT_STARTED = "started"
        internal const val IMPORT_SUCCESS = "success"
        internal const val IMPORT_FAILURE = "failure"
        internal const val IMPORT_CANCELLED = "cancelled"
        const val TAG = "import_dialog"

        fun decodeResult(bundle: Bundle): ImporterEvent? =
            when (bundle.getString(KEY_IMPORT_EVENT)) {
                IMPORT_STARTED -> ImporterEvent.Started
                IMPORT_SUCCESS -> ImporterEvent.Success(importCount = 0)
                IMPORT_FAILURE -> ImporterEvent.Failure
                IMPORT_CANCELLED -> ImporterEvent.Canceled
                else -> null
            }
    }
}

private fun ImporterEvent.encode(): String = when (this) {
    ImporterEvent.Started -> ImportBookmarksDialogFragment.IMPORT_STARTED
    is ImporterEvent.Success -> ImportBookmarksDialogFragment.IMPORT_SUCCESS
    ImporterEvent.Failure -> ImportBookmarksDialogFragment.IMPORT_FAILURE
    ImporterEvent.Canceled -> ImportBookmarksDialogFragment.IMPORT_CANCELLED
}
