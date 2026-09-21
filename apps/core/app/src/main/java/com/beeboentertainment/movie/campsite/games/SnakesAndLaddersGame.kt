package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Snakes and Ladders - roll, climb a ladder, slide down a snake, first one home wins.
 *
 * The game is Moksha Patam, several centuries old and out of copyright everywhere. It is
 * called Snakes and Ladders here, which is its name; the American trademarked name of the
 * same board appears nowhere in this file.
 *
 * WHY THIS IS NOT RANKED, IN SO MANY WORDS.
 *
 * War is not ranked because a player of War makes no decisions. Snakes and Ladders is the
 * purer case: there is not even a card to turn. The board is fixed, the dice are the
 * host's, and every legal move is forced. Two players sitting through it produce a winner
 * that says nothing whatever about either of them, and a leaderboard that counted it would
 * crown whoever happened to be handed the most rounds of a dice race. So [ranked] is false,
 * which also makes [tournamentReady] false through the interface's own default - a bracket
 * of dice races is a raffle with extra steps.
 *
 * That is not a reason to leave the game out. It is the one game in this catalogue a
 * four year old can play unaided, and on a plane that is worth more than a rating.
 *
 * RULE CHOICES, all of them made against the clock of a journey:
 *
 *  - NO EXACT FINISH. Reaching or passing the last square wins. The traditional rule sends
 *    you back the overshoot, which reliably turns the last three squares into the longest
 *    part of the afternoon while a child watches their token bounce.
 *  - A six rolls again, capped at three rolls in one turn. The extra roll is the bit
 *    everybody remembers; the cap is so one hot streak cannot hold the phone all journey.
 *  - A hard cap on total rolls. If it is ever reached the game stops and the token
 *    furthest along wins, because in a race that is exactly what winning means.
 *
 * Nothing in this game is secret. Every token is on one board that everybody is looking at,
 * so the snapshot is identical for every viewer including a spectator - there is nothing
 * here that a viewer check could protect.
 */
internal object SnakesAndLaddersGame : CampsiteGame {
    override val id = "snakesladders"
    override val title = "Snakes and Ladders"
    override val blurb = "Roll the dice, climb the ladders, mind the snakes. First one home wins."
    override val kind = "board"
    override val seats = Seats.of(2, 6)
    override val category = GameCategory.BOARD

    /** A dice race separates nobody. See the class comment - this is the whole reason. */
    override val ranked = false

    private const val LAST = 100
    private const val ROLL_CAP = 400
    private const val ROLLS_PER_TURN = 3

    /**
     * The traditional board: nine ladders up, ten snakes down. Square to square.
     *
     * Kept as one map because a square can only ever be the foot of one thing, and looking
     * up "what happens if I land here" is then a single question with a single answer.
     */
    private val JUMPS: Map<Int, Int> = mapOf(
        1 to 38, 4 to 14, 9 to 31, 21 to 42, 28 to 84, 36 to 44, 51 to 67, 71 to 91, 80 to 100,
        16 to 6, 47 to 26, 49 to 11, 56 to 53, 62 to 19, 64 to 60, 87 to 24, 93 to 73,
        95 to 75, 98 to 78,
    )

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size >= 2) { "Snakes and Ladders needs at least two players." }
        return Match(players.take(6), ctx)
    }

    /**
     * There is exactly one legal move in this game and the bot makes it.
     *
     * Worth saying plainly because it is the honest summary of the game as well: the bot
     * is not simple because nobody wrote a clever one, it is simple because a clever one
     * would have nothing to be clever about. It also cannot roll the dice - it asks the
     * host to, the same as a phone does.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botRoll(playerId)

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {

        /**
         * Square each token stands on, 0 to [LAST]. Kept apart from [scores] on purpose:
         * a square number is a position, not a point, and [MatchResult.scores] is read
         * back by the history and the championship table as points. The winner is
         * awarded one point, the same as every other board game here.
         */
        private val spot = linkedMapOf<String, Int>()
        private var die = 0
        private var roller = ""
        private var rollsThisTurn = 0
        private var rolls = 0

        init {
            players.forEach { spot[it] = 0 }
            prompt = ctx.nameOf(players[0]) + " rolls first."
        }

        private fun name(playerId: String): String = ctx.nameOf(playerId)

        private fun note(line: String) {
            log.add(line)
            while (log.size > 10) log.removeAt(0)
        }

        override fun onApply(move: GameMove) {
            require(move.action == "roll") { "Tap Roll." }
            require(phase == "playing") { "This game has finished." }
            require(move.playerId in players) { "You are not playing this game." }
            require(players.getOrNull(turnIndex) == move.playerId) { "It's not your turn to roll." }
            val id = move.playerId
            // THE HOST ROLLS. A phone sends the word "roll" and nothing else; there is no
            // field in this action a guest could fill in with a six.
            die = ctx.random.nextInt(1, 7)
            roller = id
            rolls++
            rollsThisTurn++
            val landed = spot.getValue(id) + die
            if (landed >= LAST) {
                spot[id] = LAST
                note(name(id) + " rolled " + die + " and got home.")
                prompt = name(id) + " is home."
                award(id, 1)
                settleWinner(id)
                return
            }
            val jump = JUMPS[landed]
            spot[id] = jump ?: landed
            note(
                when {
                    jump == null -> name(id) + " rolled " + die + " to square " + landed + "."
                    jump > landed -> name(id) + " rolled " + die + " and climbed " + landed + " to " + jump + "."
                    else -> name(id) + " rolled " + die + " and slid " + landed + " down to " + jump + "."
                }
            )
            if (rolls >= ROLL_CAP) {
                stopOnProgress("That is a long enough race for one journey.")
                return
            }
            if (die == 6 && rollsThisTurn < ROLLS_PER_TURN) {
                prompt = name(id) + " rolled a six and goes again."
                return
            }
            rollsThisTurn = 0
            turnIndex = (turnIndex + 1) % players.size
            prompt = name(players[turnIndex]) + " to roll."
        }

        /** In a race, furthest along is winning. There is nothing else to weigh. */
        private fun standings(): Map<String, Int> = players.associateWith { spot[it] ?: 0 }

        /** Whoever is furthest along, or "" when the lead is shared. */
        private fun leader(): String {
            val places = standings()
            val best = places.values.maxOrNull() ?: 0
            val leaders = places.filterValues { it == best }.keys
            return if (leaders.size == 1) leaders.first() else ""
        }

        /** Points, not squares: one to the player named, nothing to anybody else. */
        private fun pointsTo(playerId: String): Map<String, Int> =
            players.associateWith { if (it == playerId) 1 else 0 }

        private fun stopOnProgress(why: String) {
            val ahead = leader()
            prompt = why
            if (ahead.isNotBlank()) {
                winner = ahead
                award(ahead, 1)
                settle(MatchResult(Outcome.WINNER, ahead, scores.toMap(), why + " Furthest along wins."))
            } else {
                settle(MatchResult(Outcome.DRAW, "", scores.toMap(), why + " Dead level."))
            }
        }

        override fun hasAnswered(playerId: String): Boolean =
            players.getOrNull(turnIndex) != playerId

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

        override fun resultIfStoppedNow(): MatchResult {
            result()?.let { return it }
            val ahead = leader()
            return MatchResult(
                if (ahead.isNotBlank()) Outcome.WINNER else Outcome.DRAW,
                ahead,
                pointsTo(ahead),
                "Stopped - furthest along the board.",
            )
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            // All public. One board, six tokens, everybody looking at the same thing.
            put("last", LAST)
            put("seats", JsonArray(players.map { JsonPrimitive(it) }))
            put("names", JsonArray(players.map { JsonPrimitive(ctx.nameOf(it)) }))
            put("positions", JsonArray(players.map { JsonPrimitive(spot[it] ?: 0) }))
            put("die", die)
            // A monotonic event id distinguishes consecutive identical rolls in the UI.
            put("rollId", rolls)
            put("rollFaces", JsonArray(if (rolls > 0) listOf(JsonPrimitive(die)) else emptyList()))
            put("rollBy", roller)
            put("roller", roller)
            put("jumps", JsonArray(JUMPS.map { (from, to) ->
                buildJsonObject {
                    put("from", from)
                    put("to", to)
                    put("ladder", to > from)
                }
            }))
            put("myTurn", viewer != null && players.getOrNull(turnIndex) == viewer)
        }

        fun botRoll(playerId: String): GameMove? {
            if (phase != "playing") return null
            if (players.getOrNull(turnIndex) != playerId) return null
            return botAction(playerId, "roll")
        }
    }
}
