package com.beeboentertainment.movie.campsite.platehunt

import android.content.SharedPreferences
import com.beeboentertainment.movie.badges.BadgeStore
import com.beeboentertainment.movie.trip.TallyResult

/**
 * What a finished Plate & Sign Hunt round leaves behind, and nothing more.
 *
 * TWO PLACES, BOTH LOCAL:
 *  1. The running Trip, as one "tally" moment ("Spotted 34 of 64 jurisdictions") through
 *     [com.beeboentertainment.movie.trip.TripMomentSink.tally]. With no trip running the sink does
 *     nothing. There is no coordinate in a [TallyResult], so no location can ride along.
 *  2. Two badge counters, through [PlateBadgeSink].
 *
 * Nothing else is kept: no picture of a plate, no plate text, no location, nothing leaves the phone.
 */
internal object PlateHuntRecords {

    /**
     * The trip moment for a finished round, or null when nothing was spotted (a round nobody played
     * is not worth a line in the recap). [humanNames] are the seated people; a computer player is
     * never credited.
     */
    fun tally(roundId: String, summary: PlateSummary, humanNames: List<String>): TallyResult? {
        if (summary.found <= 0 || summary.total <= 0) return null
        val noun = PlateRegions.noun(summary.region)
        val text = if (summary.team) "Spotted ${summary.found} of ${summary.total} $noun"
        else "Best list: ${summary.found} of ${summary.total} $noun"
        return TallyResult(
            id = roundId,
            title = if (summary.region == PlateRegionId.ALPHABET) "Alphabet sign hunt" else "Plate hunt",
            text = text,
            found = summary.found,
            total = summary.total,
            names = humanNames,
        )
    }
}

/** Where a finished round's badge progress goes. [None] is what a test gets. */
internal interface PlateBadgeSink {
    fun finished(summary: PlateSummary)

    object None : PlateBadgeSink {
        override fun finished(summary: PlateSummary) {}
    }
}

/** Badge counters in the app's existing plain SharedPreferences, like every other badge input. */
internal class PlatePrefsBadgeSink(private val prefs: SharedPreferences) : PlateBadgeSink {
    override fun finished(summary: PlateSummary) {
        // A finished round must never fail the round that produced it.
        runCatching {
            BadgeStore.recordPlateRound(
                prefs,
                spotted = if (summary.region == PlateRegionId.ALPHABET) 0 else summary.found,
                alphabetComplete = summary.region == PlateRegionId.ALPHABET && summary.complete,
            )
        }
    }
}
