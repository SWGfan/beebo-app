package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*

/**
 * Nine Men's Morris - place nine pieces, then slide them along the lines. Three in a
 * line is a mill, and a mill takes one of your opponent's pieces off the board.
 *
 * RULE CHOICES:
 *
 *  - FLYING IS IN. A player down to exactly three pieces may move to any empty point
 *    instead of only to a neighbouring one. It is in the standard rules, and without it
 *    a player on three pieces is usually just dead while still having to take turns,
 *    which is a miserable way to spend the last five minutes of a game in a tent.
 *  - A mill may be broken and re-made on a later turn, and doing so takes another piece.
 *    That is the standard rule and it is what makes the "running mill" worth playing for.
 *  - A piece standing in a mill cannot be taken while the same player has a piece that
 *    is not in one. Standard, and it is the rule people forget most often, so the
 *    rejection message spells it out.
 *  - You lose when you are down to two pieces, or when it is your turn and you have no
 *    legal move. Being shut in is as final as being taken apart.
 *  - Fifty half-moves in the sliding phase with nothing taken is a draw, so a stalemate
 *    dance cannot run forever.
 *
 * BOARD ENCODING: twenty-four points, numbered the standard way - the outer ring first
 * (0 to 2 top, 3 to 5 and 6 to 8 the middle and inner top rows, 9 to 14 the sides, then
 * 15 to 17, 18 to 20 and 21 to 23 coming back down). [MILLS] and [NEIGHBOURS] are the
 * only definition of the shape; the page can lay the points out however it likes as long
 * as it uses these numbers. 0 empty, 1 seat one, 2 seat two.
 */
internal object MorrisGame : CampsiteGame {
    override val id = "morris"
    override val title = "Nine Men's Morris"
    override val blurb = "Line up three and take one of theirs. Get them down to two and you win."
    override val kind = "board"
    override val seats = Seats.exactly(2)
    override val category = GameCategory.BOARD

    private const val POINTS = 24
    private const val PIECES = 9

    /** Half-moves in the sliding phase with nothing taken before the game is called a draw. */
    private const val QUIET_LIMIT = 50

    /** The sixteen lines of three. Eight across the rings, eight up and down. */
    private val MILLS: List<List<Int>> = listOf(
        listOf(0, 1, 2), listOf(3, 4, 5), listOf(6, 7, 8), listOf(9, 10, 11),
        listOf(12, 13, 14), listOf(15, 16, 17), listOf(18, 19, 20), listOf(21, 22, 23),
        listOf(0, 9, 21), listOf(3, 10, 18), listOf(6, 11, 15), listOf(1, 4, 7),
        listOf(16, 19, 22), listOf(8, 12, 17), listOf(5, 13, 20), listOf(2, 14, 23),
    )

    /** Which points you can slide to. Two points are neighbours when a line joins them. */
    private val NEIGHBOURS: List<List<Int>> = listOf(
        listOf(1, 9),
        listOf(0, 2, 4),
        listOf(1, 14),
        listOf(4, 10),
        listOf(1, 3, 5, 7),
        listOf(4, 13),
        listOf(7, 11),
        listOf(4, 6, 8),
        listOf(7, 12),
        listOf(0, 10, 21),
        listOf(3, 9, 11, 18),
        listOf(6, 10, 15),
        listOf(8, 13, 17),
        listOf(5, 12, 14, 20),
        listOf(2, 13, 23),
        listOf(11, 16),
        listOf(15, 17, 19),
        listOf(12, 16),
        listOf(10, 19),
        listOf(16, 18, 20, 22),
        listOf(13, 19),
        listOf(9, 22),
        listOf(19, 21, 23),
        listOf(14, 22),
    )

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size >= 2) { "Nine Men's Morris needs two players." }
        return Match(players.take(2), ctx)
    }

    override fun botMove(match: GameMatch, playerId: String, random: kotlin.random.Random): GameMove? {
        return (match as? Match)?.botMove(playerId, random)
    }

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {

        private val board = IntArray(POINTS)
        private val inHand = intArrayOf(PIECES, PIECES)

        /** True while the player to move owes the board a capture from the mill they just made. */
        private var pending = false

        private var lastMill: List<Int> = emptyList()
        private var quiet = 0

        init {
            prompt = "Place a piece on any empty point."
        }

        // ---- rules -----------------------------------------------------------

        private fun count(seat: Int): Int = board.count { it == seat + 1 }

        /** Everything this player still owns, in hand or on the board. */
        private fun strength(seat: Int): Int = count(seat) + inHand[seat]

        /**
         * Would a piece of [seat] standing on [cell] complete a line? [vacating] is the
         * point the piece is sliding off, which no longer counts towards its old line.
         */
        private fun makesMill(cell: Int, seat: Int, vacating: Int): Boolean =
            MILLS.any { line ->
                line.contains(cell) && line.all { p -> p == cell || (p != vacating && board[p] == seat + 1) }
            }

        private fun inMill(cell: Int, seat: Int): Boolean =
            MILLS.any { line -> line.contains(cell) && line.all { board[it] == seat + 1 } }

        /** Which of [seat]'s pieces may be taken. Pieces in mills are the last resort. */
        private fun removable(seat: Int): List<Int> {
            val owned = (0 until POINTS).filter { board[it] == seat + 1 }
            val loose = owned.filter { !inMill(it, seat) }
            return if (loose.isNotEmpty()) loose else owned
        }

        private fun flying(seat: Int): Boolean = inHand[seat] == 0 && count(seat) == 3

        private fun movesFor(seat: Int): List<Pair<Int, Int>> {
            if (inHand[seat] > 0) return emptyList()
            val out = mutableListOf<Pair<Int, Int>>()
            for (from in 0 until POINTS) {
                if (board[from] != seat + 1) continue
                val targets = if (flying(seat)) (0 until POINTS).toList() else NEIGHBOURS[from]
                for (to in targets) if (board[to] == 0) out.add(from to to)
            }
            return out
        }

        // ---- moves -----------------------------------------------------------

        override fun onApply(move: GameMove) {
            require(phase == "playing") { "This game has finished." }
            val seat = players.indexOf(move.playerId)
            require(seat >= 0) { "You are watching this game." }
            require(seat == turnIndex) { "It is not your turn yet." }
            when (move.action) {
                "place" -> {
                    require(!pending) { "You made a line of three. Take one of their pieces first." }
                    doPlace(seat, move.int("cell"))
                }
                "move" -> {
                    require(!pending) { "You made a line of three. Take one of their pieces first." }
                    doSlide(seat, move.int("from"), move.int("to"))
                }
                "remove" -> {
                    require(pending) { "You can only take a piece straight after making a line of three." }
                    doRemove(seat, move.int("cell"))
                }
                else -> throw IllegalArgumentException("Tap a point on the board.")
            }
        }

        private fun doPlace(seat: Int, cell: Int) {
            require(inHand[seat] > 0) { "All nine of your pieces are out. Slide one along a line instead." }
            require(cell in 0 until POINTS) { "Tap a point on the board." }
            require(board[cell] == 0) { "There is already a piece on that point." }
            board[cell] = seat + 1
            inHand[seat]--
            settled(seat, cell)
        }

        private fun doSlide(seat: Int, from: Int, to: Int) {
            require(inHand[seat] == 0) { "Place all nine of your pieces before you start sliding." }
            require(from in 0 until POINTS && to in 0 until POINTS) {
                "Tap one of your pieces, then an empty point to slide it to."
            }
            require(board[from] == seat + 1) { "That is not one of your pieces." }
            require(board[to] == 0) { "There is already a piece on that point." }
            require(flying(seat) || NEIGHBOURS[from].contains(to)) {
                "Slide along a line to the next point along. You can only jump anywhere once you are down to three pieces."
            }
            board[from] = 0
            board[to] = seat + 1
            settled(seat, to)
        }

        /** Shared tail of a placement and a slide: did that make a mill, and whose turn now. */
        private fun settled(seat: Int, cell: Int) {
            val mill = MILLS.firstOrNull { line ->
                line.contains(cell) && line.all { board[it] == seat + 1 }
            }
            if (mill != null && removable(1 - seat).isNotEmpty()) {
                pending = true
                lastMill = mill
                prompt = "A line of three. Take one of your opponent's pieces."
                note(ctx.nameOf(players[seat]) + " made a line of three")
                return
            }
            lastMill = emptyList()
            if (inHand[seat] == 0 && inHand[1 - seat] == 0) quiet++
            endTurn(seat)
        }

        private fun doRemove(seat: Int, cell: Int) {
            val foe = 1 - seat
            require(cell in 0 until POINTS) { "Tap one of your opponent's pieces." }
            require(board[cell] == foe + 1) { "Tap one of your opponent's pieces." }
            require(removable(foe).contains(cell)) {
                "That piece is in a line of three, so it is safe while they still have one that is not."
            }
            board[cell] = 0
            pending = false
            lastMill = emptyList()
            quiet = 0
            note(ctx.nameOf(players[seat]) + " took a piece from " + ctx.nameOf(players[foe]))
            if (inHand[foe] == 0 && count(foe) < 3) {
                award(players[seat], 1)
                settleWinner(players[seat])
                return
            }
            endTurn(seat)
        }

        private fun endTurn(seat: Int) {
            val foe = 1 - seat
            if (inHand[foe] == 0 && movesFor(foe).isEmpty()) {
                // Shut in with nowhere to go: that is a loss, and it is why blocking is a plan.
                award(players[seat], 1)
                settleWinner(players[seat])
                return
            }
            if (inHand[0] == 0 && inHand[1] == 0 && quiet >= QUIET_LIMIT) {
                settleDraw("Fifty moves with nothing taken, so it is a draw.")
                return
            }
            turnIndex = foe
            prompt = when {
                inHand[foe] > 0 -> "Place a piece on any empty point."
                flying(foe) -> "Down to three, so you can jump to any empty point."
                else -> "Slide a piece to the next point along a line."
            }
        }

        private fun note(line: String) {
            log.add(line)
            if (log.size > 12) log.removeAt(0)
        }

        // ---- engine hooks ----------------------------------------------------

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

        /**
         * Pieces are the whole currency of this game, so an abandoned board is judged on
         * them: two clear pieces ahead, counting the ones still in hand, takes it.
         * Anything closer is a draw.
         */
        override fun resultIfStoppedNow(): MatchResult {
            result()?.let { return it }
            val first = strength(0)
            val second = strength(1)
            return when {
                first - second >= 2 ->
                    MatchResult(Outcome.WINNER, players[0], scores.toMap(), "Stopped with a clear lead.")
                second - first >= 2 ->
                    MatchResult(Outcome.WINNER, players[1], scores.toMap(), "Stopped with a clear lead.")
                else -> MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped with the board level.")
            }
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            // One board, two players looking at it. Nothing here is private.
            put("board", JsonArray(board.map { JsonPrimitive(it) }))
            put("hands", JsonArray(listOf(inHand[0], inHand[1]).map { JsonPrimitive(it) }))
            put("counts", JsonArray(listOf(count(0), count(1)).map { JsonPrimitive(it) }))
            put("winningCells", JsonArray(lastMill.map { JsonPrimitive(it) }))
            put("pending", pending)
            put("stage", if (inHand[turnIndex] > 0) "place" else "move")
            val seat = viewer?.let { players.indexOf(it) } ?: -1
            val mine = phase == "playing" && seat >= 0 && seat == turnIndex
            put("places", JsonArray(
                if (mine && !pending && inHand[seat] > 0) (0 until POINTS).filter { board[it] == 0 }.map { JsonPrimitive(it) }
                else emptyList()
            ))
            put("moves", JsonArray(
                if (mine && !pending) movesFor(seat).map { JsonPrimitive(it.first.toString() + "-" + it.second) }
                else emptyList()
            ))
            put("removable", JsonArray(
                if (mine && pending) removable(1 - seat).map { JsonPrimitive(it) } else emptyList()
            ))
        }

        // ---- bot -------------------------------------------------------------

        /**
         * Three cheap rules, in order: make a mill if you can, stop theirs if you cannot,
         * otherwise take the busiest point and toss a coin between equals. When it owes a
         * capture it takes the piece that was closest to becoming a mill.
         */
        fun botMove(playerId: String, random: kotlin.random.Random): GameMove? {
            if (phase != "playing") return null
            val seat = players.indexOf(playerId)
            if (seat < 0 || seat != turnIndex) return null
            val foe = 1 - seat
            if (pending) {
                val targets = removable(foe)
                if (targets.isEmpty()) return null
                val cell = pick(targets, random) { threat(it, foe) * 6 + NEIGHBOURS[it].count { n -> board[n] == 0 } }
                return botAction(playerId, "remove", "cell", cell)
            }
            if (inHand[seat] > 0) {
                val spots = (0 until POINTS).filter { board[it] == 0 }
                if (spots.isEmpty()) return null
                val cell = pick(spots, random) { placeScore(it, seat, foe) }
                return botAction(playerId, "place", "cell", cell)
            }
            val moves = movesFor(seat)
            if (moves.isEmpty()) return null
            val chosen = pick(moves, random) { slideScore(it, seat, foe) }
            return GameMove(playerId, "move", buildJsonObject {
                put("from", chosen.first)
                put("to", chosen.second)
            })
        }

        private fun placeScore(cell: Int, seat: Int, foe: Int): Int {
            var score = NEIGHBOURS[cell].size
            if (makesMill(cell, seat, -1)) score += 40
            if (makesMill(cell, foe, -1)) score += 25
            score += MILLS.count { it.contains(cell) && it.count { p -> board[p] == seat + 1 } == 1 } * 3
            return score
        }

        private fun slideScore(step: Pair<Int, Int>, seat: Int, foe: Int): Int {
            var score = NEIGHBOURS[step.second].count { board[it] == 0 }
            if (makesMill(step.second, seat, step.first)) score += 40
            if (makesMill(step.second, foe, -1)) score += 20
            return score
        }

        /** How close [seat] is to a mill through this point: lines with two of theirs and a gap. */
        private fun threat(cell: Int, seat: Int): Int = MILLS.count { line ->
            line.contains(cell) &&
                line.count { board[it] == seat + 1 } == 2 &&
                line.count { board[it] == 0 } == 1
        }

        private fun <T> pick(options: List<T>, random: kotlin.random.Random, score: (T) -> Int): T {
            var best = Int.MIN_VALUE
            val shortlist = mutableListOf<T>()
            for (option in options) {
                val value = score(option) + random.nextInt(3)
                if (value > best) {
                    best = value
                    shortlist.clear()
                    shortlist.add(option)
                } else if (value == best) {
                    shortlist.add(option)
                }
            }
            return shortlist[random.nextInt(shortlist.size)]
        }
    }
}
