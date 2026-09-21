package com.beeboentertainment.movie.campsite.games

import com.beeboentertainment.movie.party.games.TriviaQuestion
import kotlinx.serialization.json.*
import kotlin.random.Random

/** Everything the tournament needs from the host. Nothing here comes from a guest. */
internal interface TournamentHost {
    val random: Random
    fun now(): Long
    fun nameOf(playerId: String): String

    /** Host clock reading of this player's last request, or 0 if the session is gone. */
    fun lastSeen(playerId: String): Long

    fun trivia(count: Int): List<TriviaQuestion>

    /** One finished heat, for the saved history. */
    fun onMatchEnded(
        game: CampsiteGame,
        players: List<String>,
        result: MatchResult,
        startedAt: Long,
        endedAt: Long,
        tournamentId: String,
        roundName: String,
    )

    /** Somebody won the whole thing. */
    fun onChampion(game: CampsiteGame, championId: String, entrants: Int)
}

/**
 * A knockout bracket over one game.
 *
 * The owner's ask, in his words: four players and a two-player game means two matches
 * at the same time, then the winners play. This is the general version of that - each
 * round splits whoever is still alive into as many simultaneous heats as the game's
 * seat count allows, the winners go through, and it repeats until one is left.
 *
 * A game that seats more than two makes heats of that size instead of pairs; a game
 * that seats everybody makes one heat, which is simply a final. A game scored on points
 * rather than won outright advances its top scorer. None of that is special-cased
 * anywhere below - it falls out of [Seats] and [MatchResult].
 *
 * THE RULE THAT SHAPES EVERYTHING ELSE: a bracket must never wait on a phone. Guests
 * put phones in pockets, wander to the toilet block and go flat. So every heat has
 * three ways to end, not one:
 *
 *  1. It is played out and the game reports a result.
 *  2. One of its players has been gone for [WALKOVER_MS], or tapped leave. They forfeit
 *     that heat and whoever is still here goes through. Two minutes is deliberately
 *     longer than the room's own ninety-second grace: losing your seat in a lobby is
 *     cheap, losing a match is not. Whose turn it was does not come into it - a phone
 *     that has been dark for two minutes is not going to answer the next question
 *     either, and waiting for the turn to come round to it is exactly how a bracket
 *     deadlocks.
 *  3. Everyone is present but nothing has happened for [STALL_MS]. The heat is stopped
 *     and the GAME decides what the position is worth, via
 *     [GameMatch.resultIfStoppedNow] - a half-played board is a draw, a scored game is
 *     its current scores. The engine never invents a winner for a game it does not
 *     understand.
 *
 * If a heat ends with nobody at all (both phones gone), it advances nobody: its slot in
 * the next round simply has one fewer player, which turns into a bye. Inventing a
 * winner there would hand somebody a trophy for a match that never happened.
 */
internal class CampsiteTournament(
    val id: String,
    val game: CampsiteGame,
    entrants: List<String>,
    private val host: TournamentHost,
) {

    /** One heat, or a bye. Also exactly what one cell of the bracket screen draws. */
    internal class Bout(
        val id: String,
        val round: Int,
        val slot: Int,
        val players: List<String>,
    ) {
        var match: GameMatch? = null
        var state: String = "playing"
        var result: MatchResult? = null
        var winner: String = ""
        var note: String = ""
        var decidedBy: String = ""
        var replays: Int = 0
        var startedAt: Long = 0L
        var endedAt: Long = 0L

        /** Bumped instead of the room's counter so two live heats cannot cancel each other's taps. */
        var seq: Int = 1

        val ended: Boolean get() = state != "playing"
    }

    val entrants: List<String> = entrants.toList()
    val startedAt: Long = host.now()

    var state: String = "running"
        private set
    var endedAt: Long = 0L
        private set
    var championId: String = ""
        private set
    var note: String = ""
        private set

    /** Bumped on any bracket change so a screen can redraw without diffing. */
    var revision: Int = 0
        private set

    private val rounds = mutableListOf<MutableList<Bout>>()
    private val byes = linkedMapOf<String, Int>()
    private val wins = linkedMapOf<String, Int>()
    private val losses = linkedMapOf<String, Int>()
    private val withdrawn = linkedSetOf<String>()
    private var counter = 0
    private var touched = host.now()

    init {
        require(game.tournamentReady) { "That game does not run as a tournament." }
        require(this.entrants.size >= 2) { "A tournament needs at least two players." }
        startRound(this.entrants)
    }

    // ---- who is where ---------------------------------------------------------

    fun boutFor(playerId: String): Bout? =
        rounds.lastOrNull()?.firstOrNull { playerId in it.players && !it.ended }

    fun matchFor(playerId: String): GameMatch? = boutFor(playerId)?.match

    /**
     * One heat by its id, for somebody who picked it off the bracket to WATCH.
     *
     * Read-only, and deliberately says nothing about who is asking: the caller decides
     * whether the asker is a player in it. The only safe thing to do with a heat you
     * are not in is render it with no viewer, which is what the service does - the
     * bracket snapshot has never carried game state for exactly this reason, and this
     * is not a second door into it.
     */
    fun boutById(boutId: String): Bout? =
        if (boutId.isBlank()) null else rounds.flatten().firstOrNull { it.id == boutId }

    /** The replay counter this player's phone should be echoing back right now. */
    fun roundCounterFor(playerId: String): Int = boutFor(playerId)?.seq ?: 0

    fun isPlaying(playerId: String): Boolean = boutFor(playerId) != null

    /** Still in the running: they have not lost, been voided out, or withdrawn. */
    fun isAlive(playerId: String): Boolean =
        state == "running" && playerId !in withdrawn && aliveAfterLastRound().contains(playerId)

    private fun aliveAfterLastRound(): Set<String> {
        val round = rounds.lastOrNull() ?: return emptySet()
        return round.flatMap { bout -> if (bout.ended) listOfNotNull(bout.winner.ifBlank { null }) else bout.players }
            .toSet()
    }

    /**
     * A guest tapped "leave". That is a decision, not a flat battery, so they forfeit
     * their heat at once rather than holding it up for two minutes.
     */
    fun withdraw(playerId: String) {
        if (state != "running" || playerId !in entrants) return
        withdrawn.add(playerId)
        touched = host.now()
        revision++
    }

    /** They came back before the heat was decided. No penalty - this is a campsite. */
    fun rejoin(playerId: String) {
        if (withdrawn.remove(playerId)) revision++
    }

    fun cancel(reason: String) {
        if (state != "running") return
        state = "cancelled"
        note = reason
        endedAt = host.now()
        rounds.lastOrNull()?.forEach { bout ->
            if (!bout.ended) {
                bout.state = "void"
                bout.endedAt = endedAt
                bout.note = reason
                bout.match?.close(MatchResult(Outcome.VOID, "", emptyMap(), reason), reason)
            }
        }
        revision++
    }

    // ---- the clock ------------------------------------------------------------

    /**
     * Called on every guest request, which is every second or so while anybody is
     * looking. Cheap, and it means the bracket keeps moving even if the only person
     * still awake is a spectator.
     */
    fun tick() {
        if (state != "running") return
        val round = rounds.lastOrNull() ?: return
        var changed = false
        round.toList().forEach { if (resolve(it)) changed = true }
        if (round.all { it.ended }) {
            advance()
            changed = true
        } else if (host.now() - touched > IDLE_MS) {
            cancel("Nobody played for a while, so the tournament was put away.")
            changed = true
        }
        if (changed) revision++
    }

    private fun resolve(bout: Bout): Boolean {
        if (bout.ended) return false
        val match = bout.match ?: return false
        val finished = match.result()
        if (finished != null) {
            conclude(bout, finished, "")
            return true
        }
        val t = host.now()
        val absent = { id: String -> id in withdrawn || t - host.lastSeen(id) > WALKOVER_MS }
        // Anybody in the heat who has gone, not only the one whose turn it is: a heat
        // whose other seat is empty is over however the turn order happens to stand.
        val blocking = bout.players.filter(absent)
        if (blocking.isNotEmpty()) {
            val left = bout.players.filter { !absent(it) }
            when {
                left.size == 1 -> conclude(
                    bout,
                    MatchResult(Outcome.WALKOVER, left.first(), match.resultIfStoppedNow().scores),
                    host.nameOf(blocking.first()) + " did not come back, so " + host.nameOf(left.first()) + " goes through.",
                )
                left.isEmpty() -> conclude(
                    bout,
                    MatchResult(Outcome.VOID, "", emptyMap()),
                    "Both players left, so nobody goes through.",
                )
                // A heat of three or more with one absentee: stop it and let the game
                // judge the position between the players who are still here.
                else -> conclude(bout, restrict(match.resultIfStoppedNow(), left), "Stopped early - not everybody came back.")
            }
            return true
        }
        if (t - match.lastMoveAt > STALL_MS) {
            conclude(bout, match.resultIfStoppedNow(), "Nothing happened for a while, so this one was called.")
            return true
        }
        return false
    }

    /** Keep only players who are still here when deciding a part-played heat. */
    private fun restrict(result: MatchResult, present: List<String>): MatchResult {
        val scores = result.scores.filterKeys { it in present }
        val best = scores.values.maxOrNull()
        val leaders = scores.filterValues { it == best }.keys
        return MatchResult(
            outcome = if (leaders.size == 1) Outcome.WINNER else Outcome.DRAW,
            winnerId = if (leaders.size == 1) leaders.first() else "",
            scores = scores,
            note = result.note,
        )
    }

    private fun conclude(bout: Bout, raw: MatchResult, why: String) {
        val undecided = raw.outcome == Outcome.DRAW ||
            (raw.outcome == Outcome.SCORES && raw.winnerId.isBlank())
        var result = raw
        if (undecided && raw.outcome != Outcome.VOID) {
            val stillHere = bout.players.filter { it !in withdrawn && host.now() - host.lastSeen(it) <= WALKOVER_MS }
            // A draw in a knockout has to be broken somehow. Replaying once is the
            // fairest answer while both players are standing there - it is decided by
            // playing, not by arithmetic. Beyond that, or if somebody has gone, fall to
            // the ladder rather than leaving the bracket stuck forever.
            if (bout.replays < MAX_REPLAYS && stillHere.size == bout.players.size && why.isBlank()) {
                replay(bout)
                return
            }
            val candidates = stillHere.ifEmpty { bout.players }
            val decided = tiebreak(candidates)
            bout.decidedBy = "countback"
            result = MatchResult(Outcome.WINNER, decided, raw.scores, "Drawn, decided on countback.")
        }
        bout.result = result
        bout.winner = result.winnerId
        bout.note = why.ifBlank { result.note }
        bout.endedAt = host.now()
        bout.state = if (result.outcome == Outcome.VOID) "void" else "complete"
        bout.match?.let { live ->
            if (live.result() == null) live.close(result, bout.note)
        }
        bout.players.forEach { if (it != result.winnerId) losses[it] = (losses[it] ?: 0) + 1 }
        if (result.winnerId.isNotBlank()) wins[result.winnerId] = (wins[result.winnerId] ?: 0) + 1
        touched = host.now()
        if (result.outcome != Outcome.VOID) {
            host.onMatchEnded(
                game = game,
                players = bout.players,
                result = result,
                startedAt = bout.startedAt,
                endedAt = bout.endedAt,
                tournamentId = id,
                roundName = roundName(bout.round, rounds.getOrNull(bout.round)?.size ?: 1),
            )
        }
    }

    /**
     * The draw ladder, in order: who has won more in this tournament, then who has had
     * fewer byes (they have played for it), then the host's own shuffle. Never the seat
     * order, which would always favour whoever joined first.
     */
    private fun tiebreak(candidates: List<String>): String {
        if (candidates.isEmpty()) return ""
        val bestWins = candidates.maxOf { wins[it] ?: 0 }
        val onWins = candidates.filter { (wins[it] ?: 0) == bestWins }
        if (onWins.size == 1) return onWins.first()
        val fewestByes = onWins.minOf { byes[it] ?: 0 }
        val onByes = onWins.filter { (byes[it] ?: 0) == fewestByes }
        if (onByes.size == 1) return onByes.first()
        return onByes.random(host.random)
    }

    private fun replay(bout: Bout) {
        bout.replays++
        bout.seq++
        bout.note = "Drawn. Playing a decider."
        bout.startedAt = host.now()
        bout.match = build(bout)
        touched = host.now()
        revision++
    }

    // ---- building rounds ------------------------------------------------------

    private fun advance() {
        val winners = rounds.last().mapNotNull { it.winner.ifBlank { null } }
            .filter { it !in withdrawn }
        when {
            winners.size == 1 -> {
                state = "complete"
                championId = winners.first()
                endedAt = host.now()
                host.onChampion(game, championId, entrants.size)
            }
            winners.isEmpty() -> {
                state = "abandoned"
                note = "Nobody was left to finish it."
                endedAt = host.now()
            }
            else -> runCatching { startRound(winners) }.onFailure {
                state = "abandoned"
                note = it.message ?: "The next round could not be started."
                endedAt = host.now()
            }
        }
    }

    private fun startRound(players: List<String>) {
        if (players.size <= 1) {
            state = "complete"
            championId = players.firstOrNull().orEmpty()
            endedAt = host.now()
            if (championId.isNotBlank()) host.onChampion(game, championId, entrants.size)
            return
        }
        val index = rounds.size
        val perMatch = minOf(game.seats.max, players.size)
        val pool = players.shuffled(host.random).toMutableList()
        val remainder = pool.size % perMatch
        val byeCount = if (remainder in 1 until game.seats.min) remainder else 0
        val sittingOut = (0 until byeCount).map { pickBye(pool) }
        val round = mutableListOf<Bout>()
        pool.chunked(perMatch).forEachIndexed { slot, group ->
            val bout = Bout("m" + (++counter), index, slot, group)
            bout.startedAt = host.now()
            bout.match = build(bout)
            round.add(bout)
        }
        sittingOut.forEach { player ->
            val bout = Bout("m" + (++counter), index, round.size, listOf(player))
            bout.state = "bye"
            bout.winner = player
            bout.note = "Bye - nobody left to play this round."
            bout.startedAt = host.now()
            bout.endedAt = host.now()
            round.add(bout)
        }
        rounds.add(round)
        touched = host.now()
        revision++
    }

    /**
     * Whoever has sat out fewest so far, with a shuffle between equals.
     *
     * The obvious implementations are both unfair: the last player in the list always
     * gets it (punishes whoever joined last), or it is random every round (the same
     * person can get three in a row). Fewest-byes-first guarantees nobody gets a second
     * bye until everybody has had one, and the shuffle stops the tie being settled by
     * join order.
     */
    private fun pickBye(pool: MutableList<String>): String {
        val fewest = pool.minOf { byes[it] ?: 0 }
        val chosen = pool.filter { (byes[it] ?: 0) == fewest }.random(host.random)
        pool.remove(chosen)
        byes[chosen] = fewest + 1
        return chosen
    }

    private fun build(bout: Bout): GameMatch = game.create(
        bout.players,
        "",
        SimpleMatchContext(
            random = host.random,
            clock = host::now,
            names = host::nameOf,
            // Seat 0 runs the heat. The room's own leader may not be in this match at
            // all, and a heat that waits for somebody who is not at it never finishes.
            leaderOf = { bout.players.first() },
            bump = { bout.seq++ },
            triviaSource = host::trivia,
        ),
    )

    private fun roundName(index: Int, size: Int): String = when {
        size == 1 -> "Final"
        size == 2 -> "Semi-finals"
        size <= 4 -> "Quarter-finals"
        else -> "Round " + (index + 1)
    }

    // ---- the snapshot a bracket screen consumes -------------------------------

    /**
     * The whole bracket, for [viewer].
     *
     * Deliberately contains NO game state: ids, names, scores, who is through and who
     * is waiting, and one short public line per heat. Somebody watching the bracket must
     * not be able to read the board of the heat they are about to play, let alone
     * anybody's cards, so the private half of a match is only ever reachable through
     * that player's own room view.
     */
    fun snapshot(viewer: String?): JsonObject = buildJsonObject {
        val t = host.now()
        put("id", id)
        put("game", game.id)
        put("title", game.title)
        put("state", state)
        put("note", note)
        put("revision", revision)
        put("startedAt", startedAt)
        put("endedAt", endedAt)
        put("seatsPerMatch", minOf(game.seats.max, entrants.size))
        put("round", (rounds.size - 1).coerceAtLeast(0))
        put("roundCount", rounds.size)
        put("championId", championId)
        put("championName", if (championId.isBlank()) "" else host.nameOf(championId))
        put("yourMatch", viewer?.let { boutFor(it)?.id }.orEmpty())
        put("yourTurn", viewer != null && boutFor(viewer)?.match?.waitingOn()?.contains(viewer) == true)
        put("players", buildJsonArray {
            entrants.forEach { player ->
                add(buildJsonObject {
                    put("id", player)
                    put("name", host.nameOf(player))
                    put("alive", isAlive(player))
                    put("wins", wins[player] ?: 0)
                    put("losses", losses[player] ?: 0)
                    put("byes", byes[player] ?: 0)
                    put("withdrawn", player in withdrawn)
                    put("online", t - host.lastSeen(player) < ONLINE_MS)
                    put("matchId", boutFor(player)?.id.orEmpty())
                })
            }
        })
        put("rounds", buildJsonArray {
            rounds.forEachIndexed { index, round ->
                add(buildJsonObject {
                    put("index", index)
                    put("name", roundName(index, round.count { it.state != "bye" }.coerceAtLeast(1)))
                    put("state", if (round.all { it.ended }) "complete" else "playing")
                    put("matches", buildJsonArray { round.forEach { add(boutJson(it, viewer, t)) } })
                })
            }
        })
    }

    private fun boutJson(bout: Bout, viewer: String?, t: Long): JsonObject = buildJsonObject {
        put("id", bout.id)
        put("round", bout.round)
        put("slot", bout.slot)
        put("state", bout.state)
        put("outcome", bout.result?.outcome?.wire ?: if (bout.state == "bye") "bye" else "")
        put("winnerId", bout.winner)
        put("winnerName", if (bout.winner.isBlank()) "" else host.nameOf(bout.winner))
        put("note", bout.note)
        put("decidedBy", bout.decidedBy)
        put("replays", bout.replays)
        put("startedAt", bout.startedAt)
        put("endedAt", bout.endedAt)
        put("yours", viewer != null && viewer in bout.players)
        put("line", bout.match?.line().orEmpty())
        put("waitingOn", JsonArray(bout.match?.waitingOn().orEmpty().map { JsonPrimitive(host.nameOf(it)) }))
        put("players", buildJsonArray {
            bout.players.forEach { player ->
                add(buildJsonObject {
                    put("id", player)
                    put("name", host.nameOf(player))
                    put("score", bout.match?.scoreOf(player) ?: 0)
                    put("online", t - host.lastSeen(player) < ONLINE_MS)
                    put("through", player == bout.winner)
                })
            }
        })
    }

    companion object {
        /** How long a phone we are waiting on may be gone before it forfeits that heat. */
        private const val WALKOVER_MS = 120_000L

        /** Everybody present but nothing happening: call it and let the game judge. */
        private const val STALL_MS = 360_000L

        /** A whole bracket with no activity at all is put away. */
        private const val IDLE_MS = 20 * 60_000L

        private const val ONLINE_MS = 12_000L

        /** One decider, then the countback ladder. */
        private const val MAX_REPLAYS = 1
    }
}
