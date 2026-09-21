package com.beeboentertainment.movie.voice

import android.app.SearchManager
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.provider.BaseColumns
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.core.VoiceSearch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Google TV / Android TV global search ("Hey Google, Friends" on the TV remote, or typing in the
 * system search): answers with matching titles from the home computer's library. Picking a film
 * plays it; picking a show opens it in Beebo. Read only by the system search (GLOBAL_SEARCH).
 *
 * Declared through res/xml/searchable.xml on [VoiceSearchActivity].
 */
class TvSearchProvider : ContentProvider() {

    private val columns = arrayOf(
        BaseColumns._ID,
        SearchManager.SUGGEST_COLUMN_TEXT_1,
        SearchManager.SUGGEST_COLUMN_TEXT_2,
        SearchManager.SUGGEST_COLUMN_RESULT_CARD_IMAGE,
        SearchManager.SUGGEST_COLUMN_CONTENT_TYPE,
        SearchManager.SUGGEST_COLUMN_PRODUCTION_YEAR,
        SearchManager.SUGGEST_COLUMN_INTENT_DATA
    )

    override fun onCreate(): Boolean = true

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val cursor = MatrixCursor(columns)
        val text = selectionArgs?.firstOrNull()?.takeIf { it.isNotBlank() } ?: uri.lastPathSegment?.takeIf { it != SearchManager.SUGGEST_URI_PATH_QUERY }
        if (text.isNullOrBlank() || text.length < 2) return cursor
        val app = runCatching { BeeboApp.instance }.getOrNull() ?: return cursor
        if (!app.session.isLoggedIn) return cursor
        val limit = uri.getQueryParameter(SearchManager.SUGGEST_PARAMETER_LIMIT)?.toIntOrNull() ?: 10
        // Search runs on a binder thread; never hold the system's search UI for long.
        val hits = runBlocking { withTimeoutOrNull(4_000) { VoiceLibrary.search(text, limit) } } ?: return cursor
        hits.forEachIndexed { i, (c, movie) ->
            val show = c.kind == VoiceSearch.Focus.SHOW
            val poster = if (show) VoiceLibrary.showPoster(c.id) else movie?.poster
            cursor.addRow(arrayOf<Any?>(
                i.toLong(),
                c.title,
                if (show) "TV show on Beebo" else "Film on Beebo",
                UrlUtils.join(app.session.baseUrl, poster),
                if (show) "video/beebo-show" else "video/beebo-movie",
                c.year,
                if (show) VoiceSearchActivity.deepLink(VoiceSearchActivity.HOST_OPEN, "show", c.id).toString()
                else VoiceSearchActivity.deepLink(VoiceSearchActivity.HOST_PLAY, "movie", c.id).toString()
            ))
        }
        return cursor
    }

    override fun getType(uri: Uri): String = SearchManager.SUGGEST_MIME_TYPE
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
