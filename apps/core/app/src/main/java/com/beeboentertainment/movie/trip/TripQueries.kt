package com.beeboentertainment.movie.trip

import com.beeboentertainment.movie.badges.BADGES
import com.beeboentertainment.movie.badges.Badge
import com.beeboentertainment.movie.campsite.games.ChampionRecord
import com.beeboentertainment.movie.campsite.games.MatchRecord
import com.beeboentertainment.movie.checklist.ChecklistItem
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** The stretch of time a trip covers, both ends inclusive. */
data class TripWindow(val start: Long, val end: Long) {
    operator fun contains(t: Long): Boolean = t in start..end
    fun widened(ms: Long): TripWindow = TripWindow(start - ms, end + ms)
}

/** The photos and videos to show, in the order they were taken, plus how many were left out. */
data class MediaPick(val shown: List<TripMedia>, val outsideCount: Int)

/**
 * Looking things up by the trip's time window. None of this captures anything new: matches,
 * badges and the packing list are already kept by the app, and a trip only says which slice of
 * that history is "ours".
 */
internal object TripQueries {

    /**
     * Photos taken shortly before "We're heading out" (packing the car) or after "We're home"
     * (the drive back) still belong to the trip. Beyond this a picture is treated as outside it.
     */
    const val MEDIA_SLACK_MS = 6L * 3_600_000L

    /** The recap picker's "no trip" choice: the old all-time recap. */
    const val ALL_ACTIVITY = "all-activity"

    /**
     * The trip the recap shows. [trips] is newest first. With no choice made it is the running trip,
     * else the most recent one; a choice of [ALL_ACTIVITY] (or no trips at all) gives null, which
     * means the recap behaves exactly as it did before trips existed.
     */
    fun selectTrip(trips: List<Trip>, choice: String?): Trip? {
        if (choice == ALL_ACTIVITY) return null
        val fallback = trips.firstOrNull { it.running } ?: trips.firstOrNull()
        return if (choice == null) fallback else trips.firstOrNull { it.id == choice } ?: fallback
    }

    /** The window a trip covers. A running trip is open-ended, so its end is [now]. */
    fun window(trip: Trip, now: Long): TripWindow =
        TripWindow(trip.startedAt, if (trip.running) maxOf(now, trip.startedAt) else trip.endedAt)

    /** Finished matches whose end falls inside the trip, oldest first. */
    fun matchesIn(window: TripWindow, matches: List<MatchRecord>): List<MatchRecord> =
        matches.filter { it.endedAt > 0L && it.endedAt in window }.sortedBy { it.endedAt }

    fun championsIn(window: TripWindow, champions: List<ChampionRecord>): List<ChampionRecord> =
        champions.filter { it.endedAt > 0L && it.endedAt in window }.sortedBy { it.endedAt }

    /**
     * Everyone the trip can name: the names the host typed, plus every name that turns up in the
     * trip's own log and in the matches played inside it. Computer players are never people and
     * are left out. Names are whatever was typed (see [TripLogic.key]).
     */
    fun roster(trip: Trip, windowMatches: List<MatchRecord>, windowChampions: List<ChampionRecord> = emptyList()): List<String> {
        val names = ArrayList<String>()
        trip.moments.forEach { names += it.names }
        windowMatches.forEach { m -> m.players.filterNot { it.bot }.forEach { names += it.name } }
        windowChampions.forEach { names += it.champion }
        return TripLogic.mergeRoster(trip.roster, names)
    }

    /**
     * The badges first earned during the trip, in catalog order: the earned set now (or at the
     * end, for a finished trip) minus the set that was already earned when the trip began.
     * Badges are sticky and carry no earned-at time, so a snapshot at each end is the only way.
     */
    fun badgesEarned(trip: Trip, earnedNow: Set<String>): List<Badge> {
        val end = if (trip.running) earnedNow else trip.badgesAtEnd.toSet()
        val fresh = end - trip.badgesAtStart.toSet()
        return BADGES.filter { it.id in fresh }
    }

    /** A copy of the packing list as it stands, in display order, with deleted rows left out. */
    fun packingSnapshot(items: List<ChecklistItem>, at: Long): PackingSnapshot =
        PackingSnapshot(
            at = at,
            items = items.filterNot { it.deleted }.sortedBy { it.createdAt }.map { PackedItem(it.text, it.checked) },
        )

    /**
     * This-or-That rounds that fall inside the trip. The game only keeps an all-time counter with
     * a first and last time, so the count can be trusted only when the whole run sits inside the
     * window; otherwise it is mixed with rounds from before or after and we say nothing.
     */
    fun thisOrThatRounds(window: TripWindow, rounds: Int, firstMs: Long, lastMs: Long): Int =
        if (rounds > 0 && firstMs > 0L && lastMs > 0L && firstMs in window && lastMs in window) rounds else 0

    /**
     * Which of the picked photos and videos to show. The system photo picker cannot filter by date,
     * so the person picks freely and this puts them in taken-order and sets aside the ones whose
     * date clearly falls outside the trip (counted, so the screen can offer to include them).
     * A picture with no known date is kept: better shown out of order than silently dropped.
     */
    fun pickMedia(media: List<TripMedia>, window: TripWindow, includeOutside: Boolean): MediaPick {
        val slackWindow = window.widened(MEDIA_SLACK_MS)
        val (outside, inside) = media.partition { it.takenAt > 0L && it.takenAt !in slackWindow }
        val kept = if (includeOutside) media else inside
        val dated = kept.filter { it.takenAt > 0L }.sortedBy { it.takenAt }
        val undated = kept.filter { it.takenAt <= 0L }
        return MediaPick(dated + undated, outside.size)
    }
}

/** Dates as the recap words them. Locale and zone are parameters only so tests can pin them. */
internal object TripFormat {

    /** "Mar 6, 2026", "Mar 3 – Mar 6, 2026", or "Dec 30, 2025 – Jan 2, 2026". [endedAt] 0 means still running. */
    fun dateRange(
        startedAt: Long,
        endedAt: Long,
        now: Long,
        locale: Locale = Locale.getDefault(),
        zone: TimeZone = TimeZone.getDefault(),
    ): String {
        fun fmt(pattern: String) = SimpleDateFormat(pattern, locale).apply { timeZone = zone }
        val end = if (endedAt > 0L) endedAt else now
        val full = fmt("MMM d, yyyy")
        val day = fmt("yyyyMMdd")
        val first = Date(startedAt)
        val last = Date(maxOf(end, startedAt))
        return when {
            day.format(first) == day.format(last) -> full.format(last)
            fmt("yyyy").format(first) == fmt("yyyy").format(last) -> "${fmt("MMM d").format(first)} – ${full.format(last)}"
            else -> "${full.format(first)} – ${full.format(last)}"
        }
    }

    /** "3 hours", "1 day", "4 days": a rough length for the cover card. Whole days once past 36 hours. */
    fun length(startedAt: Long, endedAt: Long, now: Long): String {
        val end = if (endedAt > 0L) endedAt else now
        val hours = ((maxOf(end, startedAt) - startedAt) / 3_600_000L).toInt()
        return when {
            hours < 1 -> "under an hour"
            hours < 36 -> if (hours == 1) "1 hour" else "$hours hours"
            else -> {
                val days = (hours + 12) / 24
                "$days days"
            }
        }
    }
}
