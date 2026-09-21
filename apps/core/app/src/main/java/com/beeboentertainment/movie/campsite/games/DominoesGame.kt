package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*

/**
 * Dominoes - the double-six set, the draw game. Match a number on one of the two open
 * ends, take from the boneyard when you cannot, and the first player out wins.
 *
 * THIS IS THE PRIVATE-STATE GAME. A hand goes into exactly one player's snapshot, behind
 * a `viewer == owner` check, and nowhere else. Everyone else sees only how many tiles a
 * player is holding, which is public at a real table anyway because you can count them.
 * The boneyard is a count, never a list: its contents are nobody's yet. Hands are shown
 * to the room only once the round is over, which is also what happens at a real table.
 * A move names a tile by its POSITION IN THE SENDER'S OWN HAND, and the host looks the
 * tile up in its own copy - a phone can never name a tile it does not hold.
 *
 * RULE CHOICES:
 *
 *  - Double-six set, twenty-eight tiles. Two players take seven each; three or four take
 *    five each. The rest is the boneyard.
 *  - The player holding the highest double leads. With no double anywhere, the heaviest
 *    tile leads. They may open with any tile in their hand rather than the specific one
 *    that won them the lead - forcing a first move reads as a bug on a phone.
 *  - If you cannot play you MUST draw, one at a time, until you can play or the boneyard
 *    is empty. There is no drawing for fun.
 *  - PASSING IS AUTOMATIC. A player who cannot play with an empty boneyard is skipped and
 *    the room is told. There is no Pass button to hunt for, and a round cannot die
 *    because somebody did not notice it was their turn to do nothing.
 *  - Playing out your last tile wins, and scores the pips left in everybody else's hands.
 *  - A BLOCKED GAME - everybody stuck, boneyard empty - goes to the lowest pip count, and
 *    scores the difference against each other hand. Level lowest hands is a draw; there
 *    is no sudden-death tiebreak, because inventing one would be inventing a rule.
 */
internal object DominoesGame : CampsiteGame {
    override val id = "dominoes"
    override val title = "Dominoes"
    override val blurb = "Match the numbers on the ends of the line. First to use up all your dominoes wins."
    // "grid" and not "board": what a player actually taps is their own hand of tiles,
    // which is the same control set the card games use. The line in the middle is
    // something to read, not something to tap.
    override val kind = "grid"
    override val seats = Seats.of(2, 4)
    override val category = GameCategory.BOARD

    private const val HIGH = 6

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size >= 2) { "Dominoes needs at least two players." }
        return Match(players.take(4), ctx)
    }

    override fun botMove(match: GameMatch, playerId: String, random: kotlin.random.Random): GameMove? {
        return (match as? Match)?.botMove(playerId, random)
    }

    /** One tile, as laid: [a] is its left face and [b] its right face. */
    private data class Tile(val a: Int, val b: Int) {
        val pips: Int get() = a + b
        val double: Boolean get() = a == b
        fun has(n: Int): Boolean = a == n || b == n
        fun flip(): Tile = Tile(b, a)
        fun wire(): String = a.toString() + "-" + b
    }

    private fun fullSet(): List<Tile> {
        val out = mutableListOf<Tile>()
        for (a in 0..HIGH) for (b in a..HIGH) out.add(Tile(a, b))
        return out
    }

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {

        private val hands = linkedMapOf<String, MutableList<Tile>>()
        private val boneyard = mutableListOf<Tile>()

        /** The line as it lies, left to right. The open ends are its outer two faces. */
        private val line = mutableListOf<Tile>()

        init {
            val deck = fullSet().shuffled(ctx.random).toMutableList()
            val each = if (players.size <= 2) 7 else 5
            players.forEach { id ->
                val hand = mutableListOf<Tile>()
                repeat(each) { if (deck.isNotEmpty()) hand.add(deck.removeAt(0)) }
                hands[id] = hand
            }
            boneyard.addAll(deck)
            turnIndex = opener()
            prompt = "Play any domino to start the line."
        }

        /** Highest double leads; with no double anywhere, the heaviest tile does. */
        private fun opener(): Int {
            var bestSeat = 0
            var bestKey = -1
            players.forEachIndexed { seat, id ->
                hands[id].orEmpty().forEach { tile ->
                    val key = if (tile.double) 100 + tile.a else tile.pips
                    if (key > bestKey) {
                        bestKey = key
                        bestSeat = seat
                    }
                }
            }
            return bestSeat
        }

        // ---- rules -----------------------------------------------------------

        private fun leftEnd(): Int = line.first().a
        private fun rightEnd(): Int = line.last().b

        private fun canPlay(tile: Tile): Boolean =
            line.isEmpty() || tile.has(leftEnd()) || tile.has(rightEnd())

        private fun fits(tile: Tile, end: Int): Boolean = when {
            line.isEmpty() -> true
            end == 0 -> tile.has(leftEnd())
            else -> tile.has(rightEnd())
        }

        private fun pipsOf(playerId: String): Int = hands[playerId].orEmpty().sumOf { it.pips }

        // ---- moves -----------------------------------------------------------

        override fun onApply(move: GameMove) {
            require(phase == "playing") { "This round has finished." }
            val seat = players.indexOf(move.playerId)
            require(seat >= 0) { "You are watching this round." }
            require(seat == turnIndex) { "It is not your turn yet." }
            when (move.action) {
                "play" -> doPlay(move.playerId, seat, move.int("tile"), move.int("end"))
                "draw" -> doDraw(move.playerId, seat)
                "pass" -> throw IllegalArgumentException(
                    "You do not need to pass - if you cannot go, your turn moves on by itself."
                )
                else -> throw IllegalArgumentException("Tap one of your dominoes to play it.")
            }
        }

        private fun doPlay(playerId: String, seat: Int, index: Int, end: Int) {
            val hand = hands[playerId] ?: throw IllegalArgumentException("You are watching this round.")
            require(index in hand.indices) { "Tap one of your own dominoes." }
            val tile = hand[index]
            if (line.isEmpty()) {
                hand.removeAt(index)
                line.add(tile)
            } else {
                val left = tile.has(leftEnd())
                val right = tile.has(rightEnd())
                require(left || right) {
                    "That domino does not match either end. The ends are " + leftEnd() + " and " + rightEnd() + "."
                }
                val side = when {
                    end == 0 || end == 1 -> end
                    left && right -> throw IllegalArgumentException("That fits both ends. Tap the end you want to play it on.")
                    left -> 0
                    else -> 1
                }
                require(fits(tile, side)) {
                    "That end needs a " + (if (side == 0) leftEnd() else rightEnd()) + "."
                }
                hand.removeAt(index)
                if (side == 0) {
                    // Going on the left, so the tile's right face has to meet the line.
                    line.add(0, if (tile.b == leftEnd()) tile else tile.flip())
                } else {
                    line.add(if (tile.a == rightEnd()) tile else tile.flip())
                }
            }
            note(ctx.nameOf(playerId) + " played " + tile.wire())
            if (hand.isEmpty()) {
                winOut(playerId)
                return
            }
            advance(seat)
        }

        private fun doDraw(playerId: String, seat: Int) {
            val hand = hands[playerId] ?: throw IllegalArgumentException("You are watching this round.")
            require(boneyard.isNotEmpty()) { "The boneyard is empty, so there is nothing left to take." }
            require(hand.none { canPlay(it) }) { "You have a domino you can play, so you cannot take another." }
            hand.add(boneyard.removeAt(0))
            note(ctx.nameOf(playerId) + " took one from the boneyard")
            if (hand.any { canPlay(it) }) {
                prompt = "You can play now."
                return
            }
            if (boneyard.isNotEmpty()) {
                prompt = "Still nothing to play. Take another."
                return
            }
            advance(seat)
        }

        /**
         * Hand the turn on to the next player who can act: play a tile, or draw because
         * the boneyard still has one. Anybody who can do neither is skipped and the room
         * is told.
         *
         * The player who just moved is deliberately NOT one of the seats the loop visits.
         * They get the turn back only after every other player has passed, and only if
         * they can still play - that is the draw game's own rule (the others are stuck,
         * you are not, so you go again) and it is announced, never silent. If they cannot
         * play either then everybody is stuck with an empty boneyard, which is exactly
         * the blocked game described at the top of the file, and the round ends there
         * instead of the turn drifting back to whoever moved last.
         */
        private fun advance(from: Int) {
            for (hop in 1 until players.size) {
                val seat = (from + hop) % players.size
                val hand = hands[players[seat]].orEmpty()
                if (hand.any { canPlay(it) }) {
                    turnIndex = seat
                    prompt = "Match one of the ends: " + leftEnd() + " or " + rightEnd() + "."
                    return
                }
                if (boneyard.isNotEmpty()) {
                    turnIndex = seat
                    prompt = "Nothing to play. Take one from the boneyard."
                    return
                }
                note(ctx.nameOf(players[seat]) + " cannot go and passes")
            }
            // Everybody else has passed. The boneyard must be empty by now - if it were
            // not, the first seat that could not play would have been sent to draw.
            val mover = players[from]
            if (boneyard.isEmpty() && hands[mover].orEmpty().any { canPlay(it) }) {
                turnIndex = from
                note("Everybody else passed, so " + ctx.nameOf(mover) + " goes again")
                prompt = "Everybody else passed. Match one of the ends: " + leftEnd() + " or " + rightEnd() + "."
                return
            }
            blocked()
        }

        /** Played out: the winner takes the pips left in every other hand. */
        private fun winOut(playerId: String) {
            val gained = players.filter { it != playerId }.sumOf { pipsOf(it) }
            award(playerId, gained)
            note(ctx.nameOf(playerId) + " is out and scores " + gained)
            settleWinner(playerId)
        }

        /** Nobody can go: the lowest pip count takes it, and level lowest hands draw. */
        private fun blocked() {
            val totals = players.associateWith { pipsOf(it) }
            val lowest = totals.values.minOrNull() ?: 0
            val leaders = players.filter { totals[it] == lowest }
            if (leaders.size == 1) {
                val winnerId = leaders.first()
                award(winnerId, totals.values.sum() - lowest)
                note("Blocked. " + ctx.nameOf(winnerId) + " has the lightest hand.")
                settleWinner(winnerId)
            } else {
                note("Blocked, and the lightest hands are level.")
                settleDraw("Blocked, with the lightest hands level.")
            }
        }

        private fun note(entry: String) {
            log.add(entry)
            if (log.size > 12) log.removeAt(0)
        }

        // ---- engine hooks ----------------------------------------------------

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

        override fun hasAnswered(playerId: String): Boolean =
            phase != "done" && players.getOrNull(turnIndex) != playerId

        /**
         * Dominoes already owns a rule for "stop and work out who was winning": it is how
         * a blocked game is settled. So an abandoned round is judged the same way, on the
         * pips still in hand, and level hands draw.
         */
        override fun resultIfStoppedNow(): MatchResult {
            result()?.let { return it }
            val totals = players.associateWith { pipsOf(it) }
            val lowest = totals.values.minOrNull() ?: 0
            val leaders = players.filter { totals[it] == lowest }
            return if (leaders.size == 1) {
                MatchResult(Outcome.WINNER, leaders.first(), scores.toMap(), "Stopped with the lightest hand.")
            } else {
                MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped with the lightest hands level.")
            }
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            // Public: the line, how many tiles each player holds, how deep the boneyard is.
            put("line", JsonArray(line.map { JsonPrimitive(it.wire()) }))
            put("ends", JsonArray(
                if (line.isEmpty()) emptyList() else listOf(JsonPrimitive(leftEnd()), JsonPrimitive(rightEnd()))
            ))
            put("handSizes", JsonArray(players.map { JsonPrimitive(hands[it].orEmpty().size) }))
            put("boneyard", boneyard.size)

            // PRIVATE: a hand belongs to one snapshot only. A spectator has no viewer id
            // and gets nothing; another player gets their own hand and not this one.
            val mine: List<Tile> = if (viewer != null) hands[viewer].orEmpty() else emptyList()
            put("hand", JsonArray(mine.map { JsonPrimitive(it.wire()) }))
            put("playable", JsonArray(mine.indices.filter { canPlay(mine[it]) }.map { JsonPrimitive(it) }))
            val myTurn = viewer != null && viewer == players.getOrNull(turnIndex)
            put("canDraw", myTurn && boneyard.isNotEmpty() && mine.none { canPlay(it) })

            // Only once it is over, the way hands go face up at the end of a real round.
            put("reveal", JsonArray(
                if (phase == "done") {
                    players.map { id ->
                        JsonPrimitive(ctx.nameOf(id) + ": " + hands[id].orEmpty().joinToString(" ") { it.wire() })
                    }
                } else {
                    emptyList()
                }
            ))
        }

        // ---- bot -------------------------------------------------------------

        /**
         * Heaviest first, doubles a little sooner, coin toss between equals. Getting big
         * tiles down early is the one piece of dominoes advice everybody agrees on, and it
         * is also what keeps the bot from being left holding the double six when the game
         * blocks. It only ever offers a tile it is holding and an end that tile fits.
         */
        fun botMove(playerId: String, random: kotlin.random.Random): GameMove? {
            if (phase != "playing") return null
            val seat = players.indexOf(playerId)
            if (seat < 0 || seat != turnIndex) return null
            val hand = hands[playerId] ?: return null
            var bestScore = Int.MIN_VALUE
            var bestIndex = -1
            var bestEnd = 1
            val ends = if (line.isEmpty()) listOf(1) else listOf(0, 1)
            for (index in hand.indices) {
                val tile = hand[index]
                for (end in ends) {
                    if (!fits(tile, end)) continue
                    val score = tile.pips * 2 + (if (tile.double) 3 else 0) + random.nextInt(4)
                    if (score > bestScore) {
                        bestScore = score
                        bestIndex = index
                        bestEnd = end
                    }
                }
            }
            if (bestIndex >= 0) {
                val index = bestIndex
                val end = bestEnd
                return GameMove(playerId, "play", buildJsonObject {
                    put("tile", index)
                    put("end", end)
                })
            }
            if (boneyard.isNotEmpty()) return botAction(playerId, "draw")
            // Stuck with an empty boneyard: passing is automatic, so there is nothing to send.
            return null
        }
    }
}
