package com.beeboentertainment.movie.recap

import com.beeboentertainment.movie.checklist.ChecklistItem
import com.beeboentertainment.movie.data.ContinueResponse
import com.beeboentertainment.movie.trip.NameMask
import com.beeboentertainment.movie.trip.TripFormat
import com.beeboentertainment.movie.trip.TripSlides
import com.beeboentertainment.movie.trip.TripSummary
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** One line of the recap: a leading emoji and the sentence beside it. */
data class RecapStat(val emoji: String, val text: String)

/**
 * A finished recap card, ready to render or share. Pure data — no Android types — so the
 * assembly in [TripRecapBuilder] can be reasoned about (and unit-tested) on its own.
 */
data class TripRecap(
    val title: String,
    val dateRange: String,
    val stats: List<RecapStat>,
    val footer: String,
) {
    val isEmpty: Boolean get() = stats.isEmpty()
}

/**
 * Assembles a "Trip Memory Recap" from whatever local activity the app already kept, with no new
 * network calls and no required data source — every input is optional and the builder simply uses
 * what it's given:
 *
 *  - **Watch activity** from the persisted Continue-Watching list ([ContinueResponse]): how many
 *    movies vs shows are on the go, how many are finished, and which one is furthest along.
 *  - **Packing** from the shared checklist ([ChecklistItem]s): percent done and item count.
 *  - **This or That** from the small persisted play counter: rounds played this trip.
 *
 * The date range is inferred from the timestamps those sources carry (checklist edit times, first
 * and last game round). If nothing is available yet the recap is [TripRecap.isEmpty] and the screen
 * shows a friendly "just getting started" state rather than a broken card.
 */
object TripRecapBuilder {

    fun build(
        continueResponse: ContinueResponse?,
        checklist: List<ChecklistItem>,
        gameRounds: Int,
        gameFirstMs: Long,
        gameLastMs: Long,
        now: Long = System.currentTimeMillis(),
    ): TripRecap {
        val stats = mutableListOf<RecapStat>()
        val times = mutableListOf<Long>()

        // ---- Watch activity (from the cached Continue list) --------------------
        val items = continueResponse?.items.orEmpty().filter { it.title.isNotBlank() }
        if (items.isNotEmpty()) {
            val movies = items.count { it.kind.equals("movie", ignoreCase = true) }
            val shows = items.size - movies
            val parts = buildList {
                if (movies > 0) add(if (movies == 1) "1 movie" else "$movies movies")
                if (shows > 0) add(if (shows == 1) "1 show" else "$shows shows")
            }
            if (parts.isNotEmpty()) stats += RecapStat("🎬", "Watched " + parts.joinToString(" & "))

            val finished = items.count { it.percent >= 90 }
            if (finished > 0) {
                stats += RecapStat("🏁", if (finished == 1) "1 title finished" else "$finished titles finished")
            }
            val top = items.filter { it.percent in 1..89 }.maxByOrNull { it.percent }
            if (top != null) stats += RecapStat("▶️", "Furthest along: ${top.title} (${top.percent}%)")
        }

        // ---- Packing checklist -------------------------------------------------
        if (checklist.isNotEmpty()) {
            val done = checklist.count { it.checked }
            val pct = done * 100 / checklist.size
            stats += if (done == checklist.size) {
                RecapStat("🧳", "Packing list 100% done (${checklist.size} items)")
            } else {
                RecapStat("🧳", "Packing $pct% done ($done of ${checklist.size})")
            }
            checklist.forEach {
                if (it.createdAt > 0) times += it.createdAt
                if (it.updatedAt > 0) times += it.updatedAt
            }
        }

        // ---- This or That ------------------------------------------------------
        if (gameRounds > 0) {
            stats += RecapStat(
                "🎲",
                if (gameRounds == 1) "This or That: 1 round played"
                else "This or That: $gameRounds rounds played",
            )
            if (gameFirstMs > 0) times += gameFirstMs
            if (gameLastMs > 0) times += gameLastMs
        }

        return TripRecap(
            title = "Your Trip Recap",
            dateRange = dateRange(times, now),
            stats = stats,
            footer = "Beebo Entertainment",
        )
    }

    /**
     * The recap for one [TripSummary] instead of all-time inferred data: only what happened inside
     * the trip's window. Watch activity is deliberately absent - the Continue list carries no
     * timestamps, so nothing in it can be said to belong to a trip. Names are as typed; a guest
     * name identifies nobody beyond that.
     */
    internal fun buildForTrip(summary: TripSummary, now: Long = System.currentTimeMillis()): TripRecap {
        val trip = summary.trip
        val stats = mutableListOf<RecapStat>()
        TripSlides.crew(summary.roster, NameMask.ShowAll)?.let { stats += RecapStat("👥", it) }
        if (summary.gameCount > 0) {
            stats += RecapStat("🎲", TripSlides.plural(summary.gameCount, "game") + " played")
            summary.tally.firstOrNull()?.let {
                stats += RecapStat("🏆", "Most wins: ${it.name} (${it.wins})")
            }
        }
        if (summary.thisOrThatRounds > 0) {
            stats += RecapStat("🎲", "This or That: " + TripSlides.plural(summary.thisOrThatRounds, "round") + " played")
        }
        if (summary.stories.isNotEmpty()) {
            val n = summary.stories.size
            stats += RecapStat("📖", if (n == 1) "1 campfire story" else "$n campfire stories")
        }
        if (summary.hunt.isNotEmpty()) {
            stats += RecapStat("🔎", "Scavenger hunt: " + TripSlides.plural(summary.hunt.size, "waypoint") + " found")
        }
        if (summary.badges.isNotEmpty()) {
            stats += RecapStat("🎖️", "New badges: " + summary.badges.joinToString(", ") { it.title })
        }
        summary.packing?.let { p ->
            if (p.atDepart.total > 0) {
                stats += RecapStat("🧳", "Packed ${p.atDepart.packed} of ${p.atDepart.total} before leaving")
            }
        }
        return TripRecap(
            title = trip.name,
            dateRange = TripFormat.dateRange(trip.startedAt, trip.endedAt, now),
            stats = stats,
            footer = "Beebo Entertainment",
        )
    }

    /** "Mar 3 – Mar 6, 2026", or a single "Mar 6, 2026" when it all happened on one day. */
    fun dateRange(times: List<Long>, now: Long): String {
        val short = SimpleDateFormat("MMM d", Locale.getDefault())
        val full = SimpleDateFormat("MMM d, yyyy", Locale.getDefault())
        if (times.isEmpty()) return full.format(Date(now))
        val min = times.min()
        val max = times.max()
        return if (short.format(Date(min)) == short.format(Date(max))) full.format(Date(max))
        else "${short.format(Date(min))} – ${full.format(Date(max))}"
    }

    /** Plain-text version for the share sheet (and the text fallback). */
    fun toShareText(recap: TripRecap): String = buildString {
        append(recap.title).append('\n')
        append(recap.dateRange).append("\n\n")
        if (recap.stats.isEmpty()) {
            append("Our trip is just getting started — more memories to come!\n")
        } else {
            recap.stats.forEach { append(it.emoji).append(' ').append(it.text).append('\n') }
        }
        append("\n— ").append(recap.footer)
    }
}
