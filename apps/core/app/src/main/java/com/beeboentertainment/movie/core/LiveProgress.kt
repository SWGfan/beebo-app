package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.ContinueItem
import com.beeboentertainment.movie.data.EpisodesResponse
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.text.Normalizer
import kotlin.math.roundToInt

/**
 * Where the player is, shared with every screen that shows progress.
 *
 * The server hears about playback every 30 s (and on pause, stop and seek), so a list that only
 * reads the server lags behind what is on screen - and a Library open under a picture-in-picture
 * player did not move at all. PlaybackService reports here on every 5 s tick instead, the
 * Library / episode lists observe [entries], and they redraw straight away. The server stays the
 * record: [serverChanges] ticks whenever a report has reached it, which is the lists' cue to
 * fetch the real thing (e.g. the next episode once one is finished).
 */
data class LiveEntry(
    val itemId: String,
    val kind: String,
    val title: String,
    val positionMs: Long,
    /** 0 when unknown. */
    val durationMs: Long,
    val updatedAtMs: Long,
    /** Reached the finished line (95%) while this app was running. */
    val finished: Boolean,
    /** An http(s) URL the item can be reopened with, when the player has one. */
    val streamUrl: String? = null,
    val posterUrl: String? = null
) {
    val percent: Int
        get() = if (durationMs > 0) ((positionMs * 100.0) / durationMs).roundToInt().coerceIn(0, 100) else 0
}

class LiveProgressRepository {

    private val _entries = MutableStateFlow<Map<String, LiveEntry>>(emptyMap())
    val entries: StateFlow<Map<String, LiveEntry>> = _entries.asStateFlow()

    private val _serverChanges = MutableStateFlow(0)
    val serverChanges: StateFlow<Int> = _serverChanges.asStateFlow()

    /**
     * The player's position. Returns true exactly when this report crossed the finished line,
     * which is when the caller should tell the server at once rather than at the next tick.
     */
    fun report(
        itemId: String,
        kind: String,
        title: String,
        positionMs: Long,
        durationMs: Long,
        nowMs: Long,
        streamUrl: String? = null,
        posterUrl: String? = null
    ): Boolean {
        if (itemId.isBlank() || positionMs < 0L) return false
        val finishedNow = LiveProgressLogic.isFinished(positionMs, durationMs)
        var crossed = false
        _entries.update { map ->
            val prev = map[itemId]
            crossed = finishedNow && prev?.finished != true
            map + (itemId to LiveEntry(
                itemId = itemId,
                kind = if (kind == "tv") "tv" else "movie",
                title = title.ifBlank { prev?.title.orEmpty() },
                positionMs = positionMs,
                durationMs = if (durationMs > 0L) durationMs else prev?.durationMs ?: 0L,
                updatedAtMs = nowMs,
                finished = finishedNow || prev?.finished == true,
                streamUrl = streamUrl?.takeIf { it.startsWith("http://") || it.startsWith("https://") } ?: prev?.streamUrl,
                posterUrl = posterUrl ?: prev?.posterUrl
            ))
        }
        return crossed
    }

    /** A progress report reached the server: lists showing server data should refetch. */
    fun serverUpdated() = _serverChanges.update { it + 1 }

    /** Something played in the last [LiveProgressLogic.ACTIVE_WINDOW_MS]. */
    fun isPlaybackActive(nowMs: Long): Boolean =
        _entries.value.values.any { nowMs - it.updatedAtMs < LiveProgressLogic.ACTIVE_WINDOW_MS }

    /** Forget these items (unmarked watched, removed from history). */
    fun forget(ids: Collection<String>) {
        if (ids.isEmpty()) return
        val set = ids.toHashSet()
        _entries.update { map -> map.filterKeys { it !in set } }
    }

    fun clear() {
        _entries.value = emptyMap()
    }
}

/** The app's one repository: the player writes, the lists read. */
object LiveProgress {
    val shared = LiveProgressRepository()
}

/** Pure rules for turning live entries into what a list shows. */
object LiveProgressLogic {

    /** The server's line between part-watched and watched (history.js RESUME_MAX_FRACTION). */
    const val FINISHED_FRACTION = 0.95

    /** Below this a row is "didn't really start" (history.js RESUME_MIN_SECONDS). */
    const val MIN_PROGRESS_MS = 30_000L

    /** A report this recent means something is playing (or just paused) right now. */
    const val ACTIVE_WINDOW_MS = 2 * 60_000L

    fun isFinished(positionMs: Long, durationMs: Long): Boolean =
        durationMs > 0L && positionMs >= durationMs * FINISHED_FRACTION

    private fun ContinueItem.withLive(e: LiveEntry): ContinueItem = copy(
        currentTime = e.positionMs / 1000.0,
        duration = if (e.durationMs > 0L) e.durationMs / 1000.0 else duration,
        percent = if (e.durationMs > 0L) e.percent else percent,
        upNext = false
    )

    /**
     * The Continue list with the player's progress applied.
     *
     * - a row that is playing gets its bar and "min left" from the player, and moves to the top
     *   while it is actually playing;
     * - a row that crossed 95% leaves (the server's next refresh brings the next episode);
     * - an episode that is playing but not in the list takes the place of its show's row, so the
     *   list follows the player onto the next episode without waiting for the server.
     * Nothing is ever ADDED for a show or film the list does not have: that is the server's call.
     */
    fun applyToContinue(items: List<ContinueItem>, live: Map<String, LiveEntry>, nowMs: Long): List<ContinueItem> {
        if (live.isEmpty()) return items
        val ids = items.mapTo(HashSet()) { it.id }
        // Newest playing episode per show that is not in the list yet.
        val incoming = live.values
            .filter { it.kind == "tv" && it.itemId !in ids && !it.finished && it.positionMs >= MIN_PROGRESS_MS }
            .sortedByDescending { it.updatedAtMs }
            .distinctBy { ContinueGrouping.showKeyOfTitle(it.title) }
            .associateBy { ContinueGrouping.showKeyOfTitle(it.title) }

        val touched = ArrayList<Pair<ContinueItem, Long>>()
        val rest = ArrayList<ContinueItem>()
        for (item in items) {
            val e = live[item.id]
            val replacement = if (item.kind == "tv") incoming[ContinueGrouping.showKeyOf(item)] else null
            when {
                replacement != null && (e == null || replacement.updatedAtMs > e.updatedAtMs) -> {
                    val row = item.copy(
                        id = replacement.itemId,
                        title = replacement.title.ifBlank { item.title },
                        stream = replacement.streamUrl,
                        poster = item.poster ?: replacement.posterUrl,
                        watched = false
                    ).withLive(replacement)
                    touched += row to replacement.updatedAtMs
                }
                e == null -> rest += item
                e.finished -> Unit
                else -> {
                    val row = item.withLive(e)
                    if (nowMs - e.updatedAtMs < ACTIVE_WINDOW_MS) touched += row to e.updatedAtMs else rest += row
                }
            }
        }
        return touched.sortedByDescending { it.second }.map { it.first } + rest
    }

    /** All history: progress and the watched tick follow the player; nothing moves or leaves. */
    fun applyToHistory(items: List<ContinueItem>, live: Map<String, LiveEntry>): List<ContinueItem> {
        if (live.isEmpty()) return items
        return items.map { item ->
            val e = live[item.id] ?: return@map item
            item.withLive(e).copy(watched = item.watched || e.finished)
        }
    }

    /** An episode list: the playing episode's bar, and its tick once it crosses 95%. */
    fun applyToEpisodes(r: EpisodesResponse, live: Map<String, LiveEntry>): EpisodesResponse {
        if (live.isEmpty()) return r
        if (r.seasons.none { s -> s.episodes.any { it.id in live } }) return r
        return r.copy(seasons = r.seasons.map { season ->
            season.copy(episodes = season.episodes.map { ep ->
                val e = live[ep.id] ?: return@map ep
                ep.copy(
                    watchedPercent = if (e.durationMs > 0L) e.percent else ep.watchedPercent,
                    watchedAt = e.updatedAtMs,
                    watched = if (e.finished) true else ep.watched
                )
            })
        })
    }
}

/**
 * One Continue row per show, on the phone too.
 *
 * An updated desktop server does this itself; an older one still sends one row per episode,
 * and its rows arrive newest first, so keeping the first row of each show is the same answer.
 */
object ContinueGrouping {

    /** "House", "house", " HOUSE ", "Grey's Anatomy" / "Greys Anatomy" all fold together. */
    fun normaliseShowName(name: String): String =
        Normalizer.normalize(name, Normalizer.Form.NFKD)
            .replace(Regex("\\p{M}+"), "")
            .lowercase()
            .replace("&", " and ")
            .replace(Regex("['’`]"), "")
            .replace(Regex("[^a-z0-9]+"), " ")
            .trim()

    fun showKeyOfTitle(title: String): String = "tv:" + normaliseShowName(HistoryClear.showTitleOf(title))

    fun showKeyOf(item: ContinueItem): String =
        if (item.kind == "tv") showKeyOfTitle(item.title) else "movie:" + item.id

    fun group(items: List<ContinueItem>): List<ContinueItem> = items.distinctBy { showKeyOf(it) }
}

/** When the Library goes back to the server. Never while it is not on screen. */
object LibraryRefreshPolicy {
    /** Something is playing: the list should catch the server's next-episode answer soon. */
    const val ACTIVE_INTERVAL_MS = 60_000L

    /** Visible and idle: another device may have moved things on. */
    const val IDLE_INTERVAL_MS = 5 * 60_000L

    /** Resume, a server tick and an interval can land together; one fetch covers them. */
    const val MIN_GAP_MS = 5_000L

    fun intervalMs(visible: Boolean, playbackActive: Boolean): Long? = when {
        !visible -> null
        playbackActive -> ACTIVE_INTERVAL_MS
        else -> IDLE_INTERVAL_MS
    }

    fun shouldRefresh(nowMs: Long, lastRefreshMs: Long): Boolean = nowMs - lastRefreshMs >= MIN_GAP_MS
}
