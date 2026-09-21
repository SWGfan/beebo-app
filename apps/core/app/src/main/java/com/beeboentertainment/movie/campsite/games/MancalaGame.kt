package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * The rules of Mancala as Kalah is played, with no Android and no players in them, so
 * the bot's search and the tests can use them directly.
 *
 * PITS. Fourteen, counter-clockwise: 0..5 are seat one's pits left to right from seat
 * one's side, 6 is seat one's store, 7..12 are seat two's pits, 13 is seat two's store.
 * Pit `i` faces pit `12 - i`.
 *
 * THE RULES (Kalah, six pits, four stones):
 *  - Pick up every stone in one of your own non-empty pits and sow them one at a time
 *    into the following pits, counter-clockwise, including your own store and skipping
 *    your opponent's.
 *  - Last stone in your own store: you go again.
 *  - Last stone in one of your own pits that was empty, with stones in the pit
 *    opposite: you capture that stone and everything opposite into your store. If the
 *    opposite pit is empty the stone just stays - that is the commoner house rule and the
 *    one most boards are sold with.
 *  - When either side's six pits are all empty, the game ends and the other side sweeps
 *    whatever is left on their side into their own store. Most stones in store wins.
 */
internal object MancalaRules {
    const val PITS = 6
    const val STONES = 4
    const val STORE_A = 6
    const val STORE_B = 13

    fun start(stones: Int = STONES): IntArray = IntArray(14) { if (it == STORE_A || it == STORE_B) 0 else stones }

    fun storeOf(seat: Int): Int = if (seat == 0) STORE_A else STORE_B

    fun pitsOf(seat: Int): IntRange = if (seat == 0) 0..5 else 7..12

    /** Pit index for a seat's pit number 0..5. */
    fun pit(seat: Int, n: Int): Int = if (seat == 0) n else 7 + n

    fun legal(board: IntArray, seat: Int): List<Int> = pitsOf(seat).filter { board[it] > 0 }

    /** What one sowing did. [path] is every pit a stone landed in, in order, for the animation. */
    class Sow(
        val board: IntArray,
        val again: Boolean,
        val captured: Int,
        val path: List<Int>,
        val over: Boolean,
        val swept: Boolean,
    )

    /** Sow from [pitIndex] for [seat]. Throws for an illegal pit. Does not modify [board]. */
    fun sow(board: IntArray, seat: Int, pitIndex: Int): Sow {
        require(pitIndex in pitsOf(seat)) { "Choose one of the pits on your own side." }
        require(board[pitIndex] > 0) { "That pit is empty. Choose one with stones in it." }
        val b = board.copyOf()
        var hand = b[pitIndex]
        b[pitIndex] = 0
        val skip = storeOf(1 - seat)
        var at = pitIndex
        val path = ArrayList<Int>(hand)
        while (hand > 0) {
            at = (at + 1) % 14
            if (at == skip) continue
            b[at]++
            hand--
            path.add(at)
        }
        val store = storeOf(seat)
        var again = at == store
        var captured = 0
        if (!again && at in pitsOf(seat) && b[at] == 1) {
            val opposite = 12 - at
            if (b[opposite] > 0) {
                captured = b[opposite] + 1
                b[store] += captured
                b[opposite] = 0
                b[at] = 0
            }
        }
        var swept = false
        val over = pitsOf(0).all { b[it] == 0 } || pitsOf(1).all { b[it] == 0 }
        if (over) {
            for (s in 0..1) for (p in pitsOf(s)) {
                if (b[p] > 0) swept = true
                b[storeOf(s)] += b[p]
                b[p] = 0
            }
            again = false
        }
        return Sow(b, again, captured, path, over, swept)
    }

    // ---- the computer -----------------------------------------------------

    /**
     * Minimax with alpha-beta. The score is store difference from [seat]'s point of
     * view; an extra turn keeps the same player to move, so the side to maximise is
     * read from whose move it is rather than from depth parity.
     */
    fun bestPit(board: IntArray, seat: Int, depth: Int, random: Random): Int {
        val moves = legal(board, seat)
        if (moves.isEmpty()) return -1
        var best = Int.MIN_VALUE
        val shortlist = mutableListOf<Int>()
        for (m in moves) {
            val s = sow(board, seat, m)
            val next = if (s.again) seat else 1 - seat
            val v = search(s.board, next, seat, depth - 1, Int.MIN_VALUE + 1, Int.MAX_VALUE - 1, s.over)
            if (v > best) { best = v; shortlist.clear(); shortlist.add(m) } else if (v == best) shortlist.add(m)
        }
        return shortlist[random.nextInt(shortlist.size)]
    }

    private fun search(board: IntArray, toMove: Int, me: Int, depth: Int, alphaIn: Int, betaIn: Int, over: Boolean): Int {
        val diff = board[storeOf(me)] - board[storeOf(1 - me)]
        if (over) return diff * 100
        if (depth <= 0) return diff * 100 + (pitsOf(me).sumOf { board[it] } - pitsOf(1 - me).sumOf { board[it] }) * 10
        var alpha = alphaIn
        var beta = betaIn
        val moves = legal(board, toMove)
        if (toMove == me) {
            var value = Int.MIN_VALUE + 1
            for (m in moves) {
                val s = sow(board, toMove, m)
                val v = search(s.board, if (s.again) toMove else 1 - toMove, me, depth - 1, alpha, beta, s.over)
                if (v > value) value = v
                if (value > alpha) alpha = value
                if (alpha >= beta) break
            }
            return value
        } else {
            var value = Int.MAX_VALUE - 1
            for (m in moves) {
                val s = sow(board, toMove, m)
                val v = search(s.board, if (s.again) toMove else 1 - toMove, me, depth - 1, alpha, beta, s.over)
                if (v < value) value = v
                if (value < beta) beta = value
                if (alpha >= beta) break
            }
            return value
        }
    }

    fun depthFor(level: BotLevel): Int = when (level) {
        BotLevel.EASY -> 1
        BotLevel.MEDIUM -> 4
        BotLevel.HARD -> 9
    }
}

/**
 * Mancala (Kalah rules): six pits a side, four stones in each. See [MancalaRules].
 *
 * WIRE: action "move" with `pit` 0..5, counted from the left of the mover's OWN side of
 * the board as they look at it. The snapshot carries the whole board in [MancalaRules]
 * order plus `path`, the pits the last sowing dropped stones in, which is what the page
 * animates (or, with reduced motion, simply redraws).
 */
internal object MancalaGame : CampsiteGame {
    override val id = "mancala"
    override val title = "Mancala"
    override val blurb = "Sow stones round the board, capture, and fill your store. Kalah rules."
    override val kind = "board"
    override val seats = Seats.exactly(2)
    override val needsGuests = false
    override val category = GameCategory.BOARD

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size >= 2) { "Mancala needs two players." }
        return Match(players.take(2), ctx, TableOptions.parse(setup))
    }

    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? {
        val m = match as? Match ?: return null
        val seat = m.players.indexOf(playerId)
        if (m.phase != "playing" || seat < 0 || seat != m.seatToMove) return null
        val board = m.boardCopy()
        val legal = MancalaRules.legal(board, seat)
        if (legal.isEmpty()) return null
        val pit = when {
            // Easy plays a random pit a third of the time, and otherwise looks one move ahead.
            m.level == BotLevel.EASY && random.nextInt(3) == 0 -> legal.random(random)
            else -> MancalaRules.bestPit(board, seat, MancalaRules.depthFor(m.level), random)
        }
        val n = if (seat == 0) pit else pit - 7
        return botAction(playerId, "move", "pit", n)
    }

    internal class Match(players: List<String>, ctx: MatchContext, options: TableOptions) : BaseMatch(players, ctx) {
        val level: BotLevel = options.level
        private var board = MancalaRules.start()
        private var path: List<Int> = emptyList()
        private var lastSeat = -1
        private var lastPit = -1

        val seatToMove: Int get() = turnIndex

        fun boardCopy(): IntArray = board.copyOf()

        init {
            prompt = "Choose a pit on your side to sow its stones."
        }

        override fun onApply(move: GameMove) {
            require(move.action == "move") { "Tap one of the pits on your side." }
            require(phase == "playing") { "This game has finished." }
            val seat = players.indexOf(move.playerId)
            require(seat >= 0) { "You are watching this game." }
            require(seat == turnIndex) { "It is not your turn yet." }
            val n = move.int("pit")
            require(n in 0 until MancalaRules.PITS) { "Tap one of the pits on your side." }
            val pitIndex = MancalaRules.pit(seat, n)
            val sow = MancalaRules.sow(board, seat, pitIndex)
            board = sow.board
            path = sow.path
            lastSeat = seat
            lastPit = pitIndex
            val name = ctx.nameOf(move.playerId)
            if (sow.captured > 0) note(name + " captured " + sow.captured + " stones")
            if (sow.over) {
                if (sow.swept) note("One side is empty, so the stones left are swept into their stores")
                scores[players[0]] = board[MancalaRules.STORE_A]
                scores[players[1]] = board[MancalaRules.STORE_B]
                val a = board[MancalaRules.STORE_A]
                val b = board[MancalaRules.STORE_B]
                when {
                    a > b -> { prompt = ctx.nameOf(players[0]) + " wins, " + a + " to " + b + "."; settleWinner(players[0]) }
                    b > a -> { prompt = ctx.nameOf(players[1]) + " wins, " + b + " to " + a + "."; settleWinner(players[1]) }
                    else -> { prompt = "A draw, " + a + " each."; settleDraw("Level stores.") }
                }
                return
            }
            scores[players[0]] = board[MancalaRules.STORE_A]
            scores[players[1]] = board[MancalaRules.STORE_B]
            if (sow.again) {
                note(name + " finished in their store and goes again")
                prompt = name + " goes again."
            } else {
                turnIndex = 1 - seat
                prompt = "Choose a pit on your side to sow its stones."
            }
        }

        private fun note(line: String) {
            log.add(line)
            if (log.size > 12) log.removeAt(0)
        }

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

        /** Stones already in a store are banked; a lead of more than a quarter of the board decides it. */
        override fun resultIfStoppedNow(): MatchResult {
            result()?.let { return it }
            val a = board[MancalaRules.STORE_A]
            val b = board[MancalaRules.STORE_B]
            return when {
                a - b >= 12 -> MatchResult(Outcome.WINNER, players[0], scores.toMap(), "Stopped with a clear lead.")
                b - a >= 12 -> MatchResult(Outcome.WINNER, players[1], scores.toMap(), "Stopped with a clear lead.")
                else -> MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped too close to call.")
            }
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            put("board", JsonArray(board.map { JsonPrimitive(it) }))
            put("path", JsonArray(path.map { JsonPrimitive(it) }))
            put("lastSeat", lastSeat)
            put("lastPit", lastPit)
            val seat = viewer?.let { players.indexOf(it) } ?: -1
            put("mySeat", seat)
            val mine = if (phase == "playing" && seat >= 0 && seat == turnIndex)
                MancalaRules.legal(board, seat).map { if (seat == 0) it else it - 7 } else emptyList()
            put("moves", JsonArray(mine.map { JsonPrimitive(it) }))
            put("counts", JsonArray(listOf(board[MancalaRules.STORE_A], board[MancalaRules.STORE_B]).map { JsonPrimitive(it) }))
            put("level", level.wire)
        }
    }
}
