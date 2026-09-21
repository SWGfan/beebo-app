package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*

/**
 * Reversi - place a disc so it traps a line of the other colour, and that line flips.
 *
 * The name is deliberate. "Othello" is a registered trademark; Reversi is the
 * public-domain original of the same game, so the game stays and the brand name never
 * appears. The wire id is "reversi" for the same reason.
 *
 * RULE CHOICES:
 *
 *  - A move is legal only if it flips at least one disc. There is no "pass because I
 *    feel like it".
 *  - PASSING IS AUTOMATIC. If the player whose turn it would be has no legal move, the
 *    turn bounces straight back to the other player and the room is told why. That is
 *    the real rule, and it saves a guest hunting for a Pass button that is only
 *    occasionally enabled - which in a tent, with one bar of signal, is how a round
 *    dies. There is therefore no "pass" action to send.
 *  - If NEITHER player has a legal move the game ends there, whether or not the board
 *    is full. Most Reversi games actually end this way rather than on a full board.
 *  - The winner is whoever has more discs. Equal discs is a draw.
 *
 * BOARD ENCODING: sixty-four cells, row-major from the top-left. 0 empty, 1 seat one,
 * 2 seat two. Seat one moves first.
 */
internal object ReversiGame : CampsiteGame {
    override val id = "reversi"
    override val title = "Reversi"
    override val blurb = "Trap a line of your opponent's pieces and they all turn your colour."
    override val kind = "board"
    override val seats = Seats.exactly(2)
    override val category = GameCategory.BOARD

    private const val SIZE = 8
    private const val CELLS = SIZE * SIZE

    /** Once this many discs are down, a lead is worth something. Before that it is noise. */
    private const val LATE_GAME = 48

    private val CORNERS = listOf(0, SIZE - 1, CELLS - SIZE, CELLS - 1)

    /** Each square that touches a corner, mapped to the corner it hands over. */
    private val CORNER_GUARDS: Map<Int, Int> = mutableMapOf<Int, Int>().also { map ->
        for (corner in CORNERS) {
            val row = corner / SIZE
            val col = corner % SIZE
            for (dr in -1..1) {
                for (dc in -1..1) {
                    val r = row + dr
                    val c = col + dc
                    if (r !in 0 until SIZE || c !in 0 until SIZE) continue
                    val cell = r * SIZE + c
                    if (cell != corner) map[cell] = corner
                }
            }
        }
    }

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size >= 2) { "Reversi needs two players." }
        return Match(players.take(2), ctx)
    }

    override fun botMove(match: GameMatch, playerId: String, random: kotlin.random.Random): GameMove? {
        return (match as? Match)?.botMove(playerId, random)
    }

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {

        private val board = IntArray(CELLS)

        init {
            // The standard opening four in the middle, seat one to move.
            board[3 * SIZE + 3] = 2
            board[3 * SIZE + 4] = 1
            board[4 * SIZE + 3] = 1
            board[4 * SIZE + 4] = 2
            prompt = "Place a piece so it traps a line of your opponent's."
        }

        // ---- rules -----------------------------------------------------------

        /** Every disc this move would turn over. Empty means the move is not legal. */
        private fun flips(cell: Int, seat: Int): List<Int> {
            if (cell !in 0 until CELLS || board[cell] != 0) return emptyList()
            val mine = seat + 1
            val row = cell / SIZE
            val col = cell % SIZE
            val out = mutableListOf<Int>()
            for (dr in -1..1) {
                for (dc in -1..1) {
                    if (dr == 0 && dc == 0) continue
                    val run = mutableListOf<Int>()
                    var r = row + dr
                    var c = col + dc
                    var closed = false
                    while (r in 0 until SIZE && c in 0 until SIZE) {
                        val at = board[r * SIZE + c]
                        if (at == 0) break
                        if (at == mine) {
                            closed = true
                            break
                        }
                        run.add(r * SIZE + c)
                        r += dr
                        c += dc
                    }
                    if (closed && run.isNotEmpty()) out.addAll(run)
                }
            }
            return out
        }

        private fun legalCells(seat: Int): List<Int> =
            (0 until CELLS).filter { flips(it, seat).isNotEmpty() }

        private fun discs(seat: Int): Int = board.count { it == seat + 1 }

        // ---- moves -----------------------------------------------------------

        override fun onApply(move: GameMove) {
            require(move.action == "move") { "Tap an empty square to place your piece." }
            require(phase == "playing") { "This game has finished." }
            val seat = players.indexOf(move.playerId)
            require(seat >= 0) { "You are watching this game." }
            require(seat == turnIndex) { "It is not your turn yet." }
            val cell = move.int("cell")
            require(cell in 0 until CELLS) { "Tap an empty square to place your piece." }
            require(board[cell] == 0) { "There is already a piece on that square." }
            val turned = flips(cell, seat)
            require(turned.isNotEmpty()) {
                "That square does not trap any of your opponent's pieces. Try one of the highlighted squares."
            }
            board[cell] = seat + 1
            turned.forEach { board[it] = seat + 1 }
            note(ctx.nameOf(move.playerId) + " turned " + turned.size + (if (turned.size == 1) " piece" else " pieces"))
            advance(seat)
        }

        private fun advance(seat: Int) {
            val other = 1 - seat
            if (legalCells(other).isNotEmpty()) {
                turnIndex = other
                prompt = "Place a piece so it traps a line of your opponent's."
                return
            }
            if (legalCells(seat).isNotEmpty()) {
                // One side stuck and the other not: the turn comes straight back.
                note(ctx.nameOf(players[other]) + " has no move and passes")
                prompt = ctx.nameOf(players[other]) + " cannot go, so play again."
                return
            }
            finish()
        }

        /** Nobody can move, so the discs are counted and that is that. */
        private fun finish() {
            val first = discs(0)
            val second = discs(1)
            when {
                first > second -> {
                    award(players[0], 1)
                    settleWinner(players[0])
                }
                second > first -> {
                    award(players[1], 1)
                    settleWinner(players[1])
                }
                else -> settleDraw("Level on pieces, so it is a draw.")
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
         * A disc lead in Reversi means almost nothing until the end - the player ahead
         * in the middle game is often the one about to lose the corners. So an abandoned
         * board is a draw unless it was nearly finished, and only then does the count
         * decide it.
         */
        override fun resultIfStoppedNow(): MatchResult {
            result()?.let { return it }
            val placed = discs(0) + discs(1)
            val first = discs(0)
            val second = discs(1)
            if (placed < LATE_GAME || first == second) {
                return MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped too early to call.")
            }
            val leader = if (first > second) players[0] else players[1]
            return MatchResult(Outcome.WINNER, leader, scores.toMap(), "Stopped near the end, ahead on pieces.")
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            // Nothing here is private: both players are looking at the same board.
            put("board", JsonArray(board.map { JsonPrimitive(it) }))
            val seat = viewer?.let { players.indexOf(it) } ?: -1
            val mine = if (phase == "playing" && seat >= 0 && seat == turnIndex) legalCells(seat) else emptyList()
            put("moves", JsonArray(mine.map { JsonPrimitive(it) }))
            put("counts", JsonArray(listOf(discs(0), discs(1)).map { JsonPrimitive(it) }))
        }

        // ---- bot -------------------------------------------------------------

        /**
         * Greedy, with the one piece of Reversi wisdom worth having: corners are
         * permanent and the squares next to them hand a corner over. Everything else is
         * "flip the most, with a coin toss between equals".
         */
        fun botMove(playerId: String, random: kotlin.random.Random): GameMove? {
            if (phase != "playing") return null
            val seat = players.indexOf(playerId)
            if (seat < 0 || seat != turnIndex) return null
            val legal = legalCells(seat)
            if (legal.isEmpty()) return null
            var best = Int.MIN_VALUE
            val shortlist = mutableListOf<Int>()
            for (cell in legal) {
                val score = rate(cell, seat) + random.nextInt(3)
                if (score > best) {
                    best = score
                    shortlist.clear()
                    shortlist.add(cell)
                } else if (score == best) {
                    shortlist.add(cell)
                }
            }
            val chosen = shortlist[random.nextInt(shortlist.size)]
            return botAction(playerId, "move", "cell", chosen)
        }

        private fun rate(cell: Int, seat: Int): Int {
            var score = flips(cell, seat).size
            if (cell in CORNERS) return score + 50
            val guarded = CORNER_GUARDS[cell]
            // Only a bad square while the corner it guards is still up for grabs.
            if (guarded != null && board[guarded] == 0) score -= 20
            val row = cell / SIZE
            val col = cell % SIZE
            if (row == 0 || col == 0 || row == SIZE - 1 || col == SIZE - 1) score += 4
            return score
        }
    }
}
