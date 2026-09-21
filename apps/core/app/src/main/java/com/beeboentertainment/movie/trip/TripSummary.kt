package com.beeboentertainment.movie.trip

import com.beeboentertainment.movie.badges.Badge
import com.beeboentertainment.movie.campsite.games.ChampionRecord
import com.beeboentertainment.movie.campsite.games.MatchRecord

internal data class GameLine(
    val title: String,
    /** The people who won (one, or several for a team game). Empty for a draw or when a computer won. */
    val winners: List<String>,
    val botWon: Boolean,
    val outcome: String,
    val players: List<String>,
    val endedAt: Long,
)

internal data class WinTally(val name: String, val wins: Int)

internal data class ChampionLine(val game: String, val name: String)

internal data class PackingSummary(
    val atDepart: PackingSnapshot,
    val atReturn: PackingSnapshot?,
    /** Items not ticked when the trip began, in list order. */
    val leftUnpacked: List<String>,
)

/**
 * Everything the recap, the Present slideshow and the MP4 export say about one trip, worked out
 * once. Pure data: no Android types, so the same numbers reach every screen and the tests can
 * check them without a phone.
 */
internal data class TripSummary(
    val trip: Trip,
    val roster: List<String>,
    val gameCount: Int,
    val games: List<GameLine>,
    val tally: List<WinTally>,
    val champions: List<ChampionLine>,
    val stories: List<TripMoment>,
    val hunt: List<TripMoment>,
    val badges: List<Badge>,
    val packing: PackingSummary?,
    val thisOrThatRounds: Int,
) {
    val name: String get() = trip.name
    val isEmpty: Boolean
        get() = gameCount == 0 && stories.isEmpty() && hunt.isEmpty() && badges.isEmpty() && packing == null
}

internal object TripSummaryBuilder {

    fun build(
        trip: Trip,
        matches: List<MatchRecord>,
        champions: List<ChampionRecord>,
        earnedBadgesNow: Set<String>,
        thisOrThatRounds: Int = 0,
        now: Long = System.currentTimeMillis(),
    ): TripSummary {
        val window = TripQueries.window(trip, now)
        val inWindow = TripQueries.matchesIn(window, matches)
        val champs = TripQueries.championsIn(window, champions)
        val depart = trip.packingAtDepart
        return TripSummary(
            trip = trip,
            roster = TripQueries.roster(trip, inWindow, champs),
            gameCount = inWindow.size,
            games = inWindow.map { m ->
                GameLine(
                    title = m.title,
                    winners = m.players.filter { it.won && !it.bot }.map { it.name },
                    botWon = m.players.any { it.won && it.bot },
                    outcome = m.outcome,
                    players = m.players.filterNot { it.bot }.map { it.name },
                    endedAt = m.endedAt,
                )
            },
            tally = tally(inWindow),
            champions = champs.map { ChampionLine(it.title, it.champion) },
            stories = trip.moments.filter { it.kind == MomentKind.STORY },
            hunt = trip.moments.filter { it.kind == MomentKind.HUNT },
            badges = TripQueries.badgesEarned(trip, earnedBadgesNow),
            packing = if (depart.total == 0 && trip.packingAtReturn == null) null
            else PackingSummary(depart, trip.packingAtReturn, depart.items.filterNot { it.checked }.map { it.text }),
            thisOrThatRounds = thisOrThatRounds,
        )
    }

    /**
     * Wins per person over the matches. A computer player never appears (it is not a member of
     * the household, the same rule the standings use), and neither does a draw. Most wins first,
     * then alphabetical, so the order is stable.
     */
    fun tally(matches: List<MatchRecord>): List<WinTally> {
        val wins = linkedMapOf<String, Int>()
        val shown = linkedMapOf<String, String>()
        matches.forEach { m ->
            m.players.filter { it.won && !it.bot }.forEach { p ->
                val k = TripLogic.key(p.name)
                if (k.isEmpty()) return@forEach
                wins[k] = (wins[k] ?: 0) + 1
                if (k !in shown) shown[k] = p.name.trim()
            }
        }
        return wins.map { (k, n) -> WinTally(shown.getValue(k), n) }
            .sortedWith(compareByDescending<WinTally> { it.wins }.thenBy { it.name.lowercase() })
    }
}
