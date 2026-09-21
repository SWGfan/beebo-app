package com.beeboentertainment.movie.campsite.hunt

import android.content.SharedPreferences
import com.beeboentertainment.movie.badges.BadgeStore
import com.beeboentertainment.movie.trip.TallyResult

/**
 * What a finished hunt leaves behind, and nothing more.
 *
 * TWO PLACES, BOTH ON THIS PHONE:
 *  1. The running Trip Journal, as one "hunt" moment: the card's name and a count ("best list: 14 of
 *     22 items, 3 teams"), plus the nicknames of the people who played. Written through
 *     [com.beeboentertainment.movie.trip.TripMomentSink.huntCard]; with no trip running the sink does
 *     nothing. There is no item text, photo, or coordinate in a [TallyResult].
 *  2. Two badge counters ([HuntBadgeSink]).
 *
 * Nothing else is kept: not the items, not who found what, not a photo, not a location.
 */
internal object HuntRecords {

    /** The trip line for a finished hunt, or null when nothing was found (an empty hunt is not worth a line). */
    fun tally(session: HuntSession, rows: List<HuntRow>, humanNames: List<String>): TallyResult? {
        val best = rows.maxOfOrNull { it.found } ?: 0
        val total = session.items.size
        if (best <= 0 || total <= 0) return null
        val title = "Scavenger hunt: " + session.card.title
        val text = when {
            session.settings.teams == 1 -> "$title, found $best of $total items together"
            session.settings.teams >= 2 -> "$title, best list $best of $total items (${plural(rows.size, "team")})"
            rows.size <= 1 -> "$title, found $best of $total items"
            else -> "$title, best list $best of $total items (${plural(rows.size, "player")})"
        }
        return TallyResult(
            id = session.id,
            title = title,
            text = text,
            found = best,
            total = total,
            names = humanNames,
        )
    }

    private fun plural(n: Int, word: String) = if (n == 1) "1 $word" else "$n ${word}s"
}

/** Where a finished hunt's badge progress goes. [None] is what a test gets. */
internal interface HuntBadgeSink {
    /** [found] is the best list's count; [complete] is true when someone found every item. */
    fun finished(found: Int, complete: Boolean)

    object None : HuntBadgeSink {
        override fun finished(found: Int, complete: Boolean) {}
    }
}

/** Badge counters in the app's existing plain SharedPreferences, like every other badge input. */
internal class HuntPrefsBadgeSink(private val prefs: SharedPreferences) : HuntBadgeSink {
    override fun finished(found: Int, complete: Boolean) {
        // A finished hunt must never fail the hunt that produced it.
        runCatching { BadgeStore.recordHuntRound(prefs, found, complete) }
    }
}
