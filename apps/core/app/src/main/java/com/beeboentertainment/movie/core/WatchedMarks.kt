package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.ContinueItem
import com.beeboentertainment.movie.data.Episode
import com.beeboentertainment.movie.data.EpisodesResponse
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * Watched / unwatched marks, as the phone sees them.
 *
 * The server keeps ONE watched record per person per film or episode file (watchedState.js on
 * the desktop). A season or a show is never stored - it is watched when every episode in it is -
 * so everything here works from episode flags upwards.
 *
 * Marking watched takes the item out of Continue Watching and drops its resume point on the
 * server; the server answers with the ids it covered, and the app mirrors that into its own two
 * copies (ContinueCache, ResumeStore). Unmarking restores neither, on the server or here.
 */
object WatchedMarks {

    /** The four routes: POST /api/watched/{path}. */
    enum class Scope(val path: String) {
        MOVIE("movie"),
        EPISODE("episode"),
        SEASON("season"),
        SHOW("show")
    }

    /**
     * Is this episode watched?
     *
     * A server with the watched store says so outright. An older one never sends `watched`, and
     * its only signal is "last played past 95%" - the same rule 1.19 drew its tick with.
     */
    fun isWatched(e: Episode): Boolean =
        e.watched ?: (e.watchedAt != null && e.watchedAt > 0L && e.watchedPercent >= 95)

    /** How much of a season or show is watched. */
    data class Progress(val watched: Int, val total: Int) {
        val all: Boolean get() = total > 0 && watched == total
        val none: Boolean get() = watched == 0
        /** A bulk action offers "watched" until everything is, then offers "unwatched". */
        val nextMarkIsWatched: Boolean get() = !all
        /** "3 of 10 watched"; empty for an empty season or when nothing is watched. */
        val label: String get() = if (total == 0 || none) "" else if (all) "All watched" else "$watched of $total watched"
    }

    fun progress(episodes: List<Episode>): Progress =
        Progress(episodes.count { isWatched(it) }, episodes.size)

    fun showProgress(r: EpisodesResponse): Progress = progress(r.seasons.flatMap { it.episodes })

    /** Every episode id in one season (null = Unsorted), in list order. */
    fun seasonIds(r: EpisodesResponse, season: Int?): List<String> =
        r.seasons.filter { it.season == season }.flatMap { it.episodes }.map { it.id }

    fun showIds(r: EpisodesResponse): List<String> = r.seasons.flatMap { it.episodes }.map { it.id }

    /**
     * The episode list after the server confirmed a mark over [ids] - what the screen shows
     * without waiting for a refetch. Mirrors how the server itself reports it: watched is 100%
     * (keeping the last-played date, or now), unwatched shows no watched line at all.
     */
    fun applyToEpisodes(r: EpisodesResponse, ids: Collection<String>, watched: Boolean, nowMs: Long): EpisodesResponse {
        if (ids.isEmpty()) return r
        val set = ids.toHashSet()
        return r.copy(seasons = r.seasons.map { season ->
            season.copy(episodes = season.episodes.map { ep ->
                if (ep.id !in set) ep
                else if (watched) ep.copy(watched = true, watchedPercent = 100, watchedAt = ep.watchedAt ?: nowMs)
                else ep.copy(watched = false, watchedPercent = 0, watchedAt = null)
            })
        })
    }

    /** Continue Watching after a confirmed mark: watched items leave, unwatched restores nothing. */
    fun continueAfter(items: List<ContinueItem>, ids: Collection<String>, watched: Boolean): List<ContinueItem> {
        if (!watched || ids.isEmpty()) return items
        val set = ids.toHashSet()
        return items.filterNot { it.id in set }
    }

    /** All-history rows after a confirmed mark: the rows stay, only their flag changes. */
    fun historyAfter(items: List<ContinueItem>, ids: Collection<String>, watched: Boolean): List<ContinueItem> {
        if (ids.isEmpty()) return items
        val set = ids.toHashSet()
        return items.map { if (it.id in set) it.copy(watched = watched) else it }
    }

    /* ------------------------------ request bodies ------------------------------ */

    fun itemBody(id: String, watched: Boolean): String = buildJsonObject {
        put("id", JsonPrimitive(id))
        put("watched", JsonPrimitive(watched))
    }.toString()

    fun showBody(showKey: String, watched: Boolean): String = buildJsonObject {
        put("showKey", JsonPrimitive(showKey))
        put("watched", JsonPrimitive(watched))
    }.toString()

    /**
     * Season null is the Unsorted bucket and must be SENT as null: the server tells "no season
     * given" (400) from "the Unsorted season" by whether the key is there, and the app's shared
     * Json leaves nulls out - so this body is built by hand.
     */
    fun seasonBody(showKey: String, season: Int?, watched: Boolean): String = buildJsonObject {
        put("showKey", JsonPrimitive(showKey))
        put("season", season?.let { JsonPrimitive(it) } ?: JsonNull)
        put("watched", JsonPrimitive(watched))
    }.toString()

    /* ---------------------------------- words ---------------------------------- */

    fun episodeMenuLabel(currentlyWatched: Boolean): String =
        if (currentlyWatched) "Mark unwatched" else "Mark watched"

    fun seasonMenuLabel(p: Progress): String =
        if (p.nextMarkIsWatched) "Mark season watched" else "Mark season unwatched"

    fun showMenuLabel(p: Progress): String =
        if (p.nextMarkIsWatched) "Mark show watched" else "Mark show unwatched"

    /** The confirmation for a bulk mark, which touches many episodes and cannot restore resume points. */
    fun bulkConfirmMessage(what: String, count: Int, watched: Boolean): String {
        val eps = if (count == 1) "1 episode" else "$count episodes"
        return if (watched)
            "Mark $eps of $what as watched? They'll leave Continue Watching and lose their resume points."
        else
            "Mark $eps of $what as unwatched? Resume points that were cleared don't come back."
    }

    /**
     * What to tell someone whose server answered 404 to an episode or season mark. Either the
     * file is gone, or the computer is running a Beebo from before these routes existed - and
     * the old route must NOT be used for an episode, because on that server it deletes the
     * episode's watch history.
     */
    const val OLD_SERVER_EPISODE_MESSAGE =
        "Your computer couldn't mark that. If Beebo on your computer hasn't been updated lately, update it to mark episodes."
}
