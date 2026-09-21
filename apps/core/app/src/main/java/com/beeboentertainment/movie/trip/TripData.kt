package com.beeboentertainment.movie.trip

import com.beeboentertainment.movie.badges.BadgeStore
import com.beeboentertainment.movie.campsite.games.CampsiteHistoryStore
import com.beeboentertainment.movie.checklist.ChecklistStore
import com.beeboentertainment.movie.data.SessionStore
import com.beeboentertainment.movie.party.games.ThisOrThatStats

/**
 * The bridge from the app's real stores to the pure trip code: reads match history, badges,
 * the packing list and the This-or-That counter, and hands them to [TripSummaryBuilder]. Kept thin
 * on purpose; everything worth testing is on the other side of it.
 */
internal object TripData {

    /** The packing list as it stands right now, for the snapshot at depart and return. */
    fun packingNow(session: SessionStore, now: Long = System.currentTimeMillis()): PackingSnapshot =
        TripQueries.packingSnapshot(ChecklistStore(session.plain).visible, now)

    /**
     * Badges earned so far, recomputed from live inputs first (the same refresh the Badges screen
     * does), so a trip started right after earning one does not count it as new.
     */
    fun badgesNow(session: SessionStore): Set<String> = BadgeStore.refresh(session.plain)

    fun summary(trip: Trip, session: SessionStore, now: Long = System.currentTimeMillis()): TripSummary {
        val history = CampsiteHistoryStore(session)
        val matches = history.recent(HISTORY_LIMIT)
        val champions = history.champions(HISTORY_LIMIT)
        val window = TripQueries.window(trip, now)
        val game = ThisOrThatStats.snapshot(session.plain)
        val earned = if (trip.running) badgesNow(session) else BadgeStore.earnedIds(session.plain)
        return TripSummaryBuilder.build(
            trip = trip,
            matches = matches,
            champions = champions,
            earnedBadgesNow = earned,
            thisOrThatRounds = TripQueries.thisOrThatRounds(window, game.rounds, game.firstMs, game.lastMs),
            now = now,
        )
    }

    /** The full roster to freeze into a trip that is ending. */
    fun rosterFor(trip: Trip, session: SessionStore, now: Long = System.currentTimeMillis()): List<String> {
        val history = CampsiteHistoryStore(session)
        val window = TripQueries.window(trip, now)
        return TripQueries.roster(
            trip,
            TripQueries.matchesIn(window, history.recent(HISTORY_LIMIT)),
            TripQueries.championsIn(window, history.champions(HISTORY_LIMIT)),
        )
    }

    private const val HISTORY_LIMIT = 500
}
