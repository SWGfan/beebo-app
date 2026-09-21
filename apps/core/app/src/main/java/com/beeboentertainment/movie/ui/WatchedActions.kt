package com.beeboentertainment.movie.ui

import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.data.ApiException
import com.beeboentertainment.movie.data.ContinueCache
import com.beeboentertainment.movie.data.WatchedMarkResponse

/**
 * The app-side half of a watched mark: calling the server, and mirroring what it confirmed into
 * the phone's own copies of Continue Watching.
 */
object WatchedActions {

    /**
     * After the server CONFIRMED a mark: a watched item has left Continue Watching and lost its
     * resume point there, so drop it from the persisted Continue cache (what the Library tab
     * paints from on a cold start) and from the phone's own resume marks (which would otherwise
     * still offer to resume it). Unwatched restores nothing, so it changes nothing here either.
     */
    fun mirror(app: BeeboApp, response: WatchedMarkResponse) {
        if (!response.ok || !response.watched) return
        for (id in response.ids) {
            ContinueCache.removeItem(app.session.plain, id)
            runCatching { app.resume.clear(id) }
        }
    }

    /**
     * A film or a whole show - the two things the details overlay's Watched chip acts on.
     *
     * A computer still running a Beebo from before /api/watched/{scope} answers that route 404;
     * for these two, and only these two, the old /api/watched does the same job there (for an
     * episode it would delete the episode's history, so episodes never fall back).
     */
    suspend fun markTitle(app: BeeboApp, kind: String, id: String, watched: Boolean): WatchedMarkResponse {
        val isShow = kind == "tv" || kind == "show"
        val response = try {
            if (isShow) app.api.markShowWatched(id, watched) else app.api.markMovieWatched(id, watched)
        } catch (e: ApiException) {
            if (e.code != 404) throw e
            val ok = app.api.setWatched(if (isShow) "tv" else "movie", id, watched).ok
            WatchedMarkResponse(ok = ok, watched = watched, count = 1, ids = if (isShow) emptyList() else listOf(id))
        }
        mirror(app, response)
        return response
    }

    /**
     * One film or episode FILE - a Continue Watching or All history row.
     *
     * Episodes fall back to the old route only to mark WATCHED, and only because that is exactly
     * what 1.19 did from these rows on an old server (where it also removes the row from history).
     * Unwatching an episode on an old server has no honest equivalent, so it just fails.
     */
    suspend fun markFile(app: BeeboApp, kind: String, id: String, watched: Boolean): WatchedMarkResponse {
        if (kind != "tv") return markTitle(app, "movie", id, watched)
        val response = try {
            app.api.markEpisodeWatched(id, watched)
        } catch (e: ApiException) {
            if (e.code != 404 || !watched) throw e
            val ok = app.api.setWatched("tv", id, true).ok
            WatchedMarkResponse(ok = ok, watched = true, count = 1, ids = listOf(id))
        }
        mirror(app, response)
        return response
    }
}
