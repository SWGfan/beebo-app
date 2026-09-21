package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * The rules of Dots and Boxes on a grid of [rows] x [cols] boxes, with no players in
 * them, so the bot and the tests can use them directly.
 *
 * LINES. Horizontal lines first, row by row: `h(r, c) = r * cols + c` for r in 0..rows
 * and c in 0 until cols. Then vertical lines: `v(r, c) = H + r * (cols + 1) + c` for r in
 * 0 until rows and c in 0..cols, where H is the number of horizontal lines.
 *
 * Box (r, c) is bounded by h(r, c), h(r + 1, c), v(r, c) and v(r, c + 1).
 */
internal class DotsBoard(val rows: Int, val cols: Int) {
    val horizontal = (rows + 1) * cols
    val lineCount = horizontal + rows * (cols + 1)
    val boxCount = rows * cols

    fun h(r: Int, c: Int) = r * cols + c
    fun v(r: Int, c: Int) = horizontal + r * (cols + 1) + c

    fun sides(box: Int): IntArray {
        val r = box / cols
        val c = box % cols
        return intArrayOf(h(r, c), h(r + 1, c), v(r, c), v(r, c + 1))
    }

    /** The one or two boxes a line borders. */
    val boxesOf: Array<IntArray> = Array(lineCount) { line ->
        if (line < horizontal) {
            val r = line / cols
            val c = line % cols
            listOfNotNull(if (r > 0) (r - 1) * cols + c else null, if (r < rows) r * cols + c else null).toIntArray()
        } else {
            val k = line - horizontal
            val r = k / (cols + 1)
            val c = k % (cols + 1)
            listOfNotNull(if (c > 0) r * cols + c - 1 else null, if (c < cols) r * cols + c else null).toIntArray()
        }
    }

    fun drawnSides(lines: BooleanArray, box: Int): Int = sides(box).count { lines[it] }

    /** Boxes completed by drawing [line] (which must not be drawn yet). */
    fun completes(lines: BooleanArray, line: Int): Int =
        boxesOf[line].count { drawnSides(lines, it) == 3 }

    /** A line that finishes no box and gives no box its third side. */
    fun isSafe(lines: BooleanArray, line: Int): Boolean =
        !lines[line] && boxesOf[line].all { drawnSides(lines, it) < 2 }

    fun open(lines: BooleanArray): List<Int> = (0 until lineCount).filter { !lines[it] }

    // ---- the computer -----------------------------------------------------

    /** Draw and greedily take every box that becomes available. Returns boxes taken. */
    fun takeAll(lines: BooleanArray): Int {
        var taken = 0
        while (true) {
            val line = (0 until lineCount).firstOrNull { !lines[it] && completes(lines, it) > 0 } ?: return taken
            taken += completes(lines, line)
            lines[line] = true
        }
    }

    /** How many boxes the opponent collects if [line] is drawn now and they take everything. */
    fun givesAway(lines: BooleanArray, line: Int): Int {
        val copy = lines.copyOf()
        copy[line] = true
        return takeAll(copy)
    }

    fun choose(lines: BooleanArray, level: BotLevel, random: Random): Int {
        val open = open(lines)
        if (open.isEmpty()) return -1
        val capturing = open.filter { completes(lines, it) > 0 }
        val safe = open.filter { isSafe(lines, it) }
        return when (level) {
            BotLevel.EASY -> when {
                capturing.isNotEmpty() && random.nextInt(10) < 7 -> capturing.random(random)
                safe.isNotEmpty() -> safe.random(random)
                else -> open.random(random)
            }
            BotLevel.MEDIUM -> when {
                capturing.isNotEmpty() -> capturing.random(random)
                safe.isNotEmpty() -> safe.random(random)
                else -> smallestGift(lines, open, random)
            }
            BotLevel.HARD -> hard(lines, open, capturing, safe, random)
        }
    }

    private fun smallestGift(lines: BooleanArray, open: List<Int>, random: Random): Int {
        var best = Int.MAX_VALUE
        val shortlist = mutableListOf<Int>()
        for (line in open) {
            val copy = lines.copyOf()
            copy[line] = true
            // A hard-hearted handout: of two ways to give away two boxes, prefer the one
            // that leaves them as two separate boxes, which cannot be declined.
            val separate = boxesOf[line].count { drawnSides(copy, it) == 3 }
            val given = takeAll(copy) * 10 - separate
            if (given < best) { best = given; shortlist.clear(); shortlist.add(line) } else if (given == best) shortlist.add(line)
        }
        return shortlist.random(random)
    }

    /**
     * THE HARD PLAYER, which is where chain counting lives.
     *
     *  1. While safe lines exist, take any free boxes, then play a safe line - but when
     *     the safe lines are few enough to count, search them to make sure it is the
     *     OPPONENT who runs out first and has to open the first chain.
     *  2. When no safe line is left and boxes are on offer, take them - except the last
     *     two of a chain when more boxes are still to come: then decline them with the
     *     double-dealing move, handing over two boxes to keep control of everything else.
     *  3. With nothing to take and nothing safe, open whatever gives away least.
     */
    private fun hard(lines: BooleanArray, open: List<Int>, capturing: List<Int>, safe: List<Int>, random: Random): Int {
        if (capturing.isNotEmpty()) {
            // Would there be any safe line left after taking everything on offer?
            val after = lines.copyOf()
            val onOffer = takeAll(after)
            val safeAfter = open(after).any { isSafe(after, it) }
            val undecided = boxCount - (0 until boxCount).count { drawnSides(lines, it) == 4 }
            val rest = undecided - onOffer
            if (!safeAfter && rest >= 3) {
                doubleDeal(lines, capturing)?.let { return it }
            }
            return capturing.random(random)
        }
        if (safe.isNotEmpty()) {
            if (safe.size <= 12) {
                val budget = intArrayOf(150_000)
                val memo = HashMap<String, Boolean>()
                for (line in safe.shuffled(random)) {
                    val copy = lines.copyOf()
                    copy[line] = true
                    // After my safe line, the opponent is to move. If they are then lost -
                    // they will be the one to run out of safe lines - this line wins control.
                    val theyWin = moverWinsSafePhase(copy, memo, budget)
                    if (budget[0] <= 0) break
                    if (!theyWin) return line
                }
            }
            return safe.random(random)
        }
        return smallestGift(lines, open, random)
    }

    /**
     * True when the player to move can make sure the OTHER player is the first with no
     * safe line. The only moves considered are safe ones, which is the whole point: in
     * the safe phase nobody gives anything away, so control is purely a parity fight.
     */
    private fun moverWinsSafePhase(lines: BooleanArray, memo: HashMap<String, Boolean>, budget: IntArray): Boolean {
        val safe = (0 until lineCount).filter { isSafe(lines, it) }
        if (safe.isEmpty()) return false
        val key = String(CharArray(lineCount) { if (lines[it]) '1' else '0' })
        memo[key]?.let { return it }
        if (--budget[0] <= 0) return false
        var wins = false
        for (line in safe) {
            lines[line] = true
            val opponentWins = moverWinsSafePhase(lines, memo, budget)
            lines[line] = false
            if (!opponentWins) { wins = true; break }
            if (budget[0] <= 0) break
        }
        memo[key] = wins
        return wins
    }

    /**
     * The double-dealing move, if the chain on offer is down to its last two boxes: a
     * box with three sides whose open side leads into a box with two, which in turn
     * leads nowhere new. Drawing that second box's far side leaves both boxes for the
     * opponent to take with one line - and then they have to move.
     */
    private fun doubleDeal(lines: BooleanArray, capturing: List<Int>): Int? {
        for (line in capturing) {
            val boxes = boxesOf[line]
            // A line that finishes two boxes at once is already a double-box: nothing to decline.
            if (boxes.count { drawnSides(lines, it) == 3 } != 1 || boxes.size != 2) continue
            val first = boxes.first { drawnSides(lines, it) == 3 }
            val second = boxes.first { it != first }
            if (drawnSides(lines, second) != 2) continue
            val far = sides(second).firstOrNull { !lines[it] && it != line } ?: continue
            val beyond = boxesOf[far].firstOrNull { it != second }
            if (beyond != null && drawnSides(lines, beyond) >= 2) continue
            // Anything else on offer elsewhere would be given away too; only decline a lone chain.
            if (capturing.any { other -> other != line && boxesOf[other].none { it == first || it == second } }) continue
            return far
        }
        return null
    }
}

/**
 * Dots and Boxes: take turns drawing a line between two dots. Close the fourth side of a
 * box and it is yours, and you must draw another line. Most boxes wins.
 *
 * SETUP: "size=3..6" boxes a side (default 4) and "level=easy|medium|hard".
 * WIRE: action "move" with `line`, numbered as in [DotsBoard].
 */
internal object DotsAndBoxesGame : CampsiteGame {
    override val id = "dotsboxes"
    override val title = "Dots and Boxes"
    override val blurb = "Draw lines, close boxes, and take another turn when you do."
    override val kind = "board"
    override val seats = Seats.of(2, 4)
    override val needsGuests = false
    override val category = GameCategory.BOARD

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size >= 2) { "Dots and Boxes needs at least two players." }
        return Match(players.take(4), ctx, TableOptions.parse(setup))
    }

    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? {
        val m = match as? Match ?: return null
        if (m.phase != "playing" || m.players.getOrNull(m.seatToMove) != playerId) return null
        val line = m.grid.choose(m.linesCopy(), m.level, random)
        return if (line < 0) null else botAction(playerId, "move", "line", line)
    }

    internal class Match(players: List<String>, ctx: MatchContext, options: TableOptions) : BaseMatch(players, ctx) {
        val level: BotLevel = options.level
        val size: Int = options.int("size", 4, 3..6)
        val grid = DotsBoard(size, size)
        private val lines = BooleanArray(grid.lineCount)
        /** Seat that drew each line, or -1. */
        private val drawnBy = IntArray(grid.lineCount) { -1 }
        /** Seat that owns each box, or -1. */
        private val owners = IntArray(grid.boxCount) { -1 }
        private var lastLine = -1

        val seatToMove: Int get() = turnIndex

        fun linesCopy(): BooleanArray = lines.copyOf()

        init {
            prompt = "Draw a line. Close a box to keep it and go again."
        }

        override fun onApply(move: GameMove) {
            require(move.action == "move") { "Tap between two dots to draw a line." }
            require(phase == "playing") { "This game has finished." }
            val seat = players.indexOf(move.playerId)
            require(seat >= 0) { "You are watching this game." }
            require(seat == turnIndex) { "It is not your turn yet." }
            val line = move.int("line")
            require(line in 0 until grid.lineCount) { "Tap between two dots to draw a line." }
            require(!lines[line]) { "That line is already drawn." }
            lines[line] = true
            drawnBy[line] = seat
            lastLine = line
            var closed = 0
            for (box in grid.boxesOf[line]) {
                if (owners[box] < 0 && grid.drawnSides(lines, box) == 4) {
                    owners[box] = seat
                    closed++
                }
            }
            val name = ctx.nameOf(move.playerId)
            if (closed > 0) {
                award(move.playerId, closed)
                note(name + " closed " + (if (closed == 1) "a box" else "two boxes"))
            }
            if (lines.all { it }) {
                finish()
                return
            }
            if (closed > 0) {
                prompt = name + " closed a box, so they go again."
            } else {
                turnIndex = (seat + 1) % players.size
                prompt = "Draw a line. Close a box to keep it and go again."
            }
        }

        private fun finish() {
            val best = scores.values.maxOrNull() ?: 0
            val leaders = scores.filterValues { it == best }.keys
            if (leaders.size == 1) {
                val w = leaders.first()
                prompt = ctx.nameOf(w) + " wins with " + best + " boxes."
                settleWinner(w)
            } else {
                prompt = "A tie on " + best + " boxes."
                settleDraw("Tied on boxes.")
            }
        }

        private fun note(line: String) {
            log.add(line)
            if (log.size > 12) log.removeAt(0)
        }

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

        /** Boxes already closed are banked; the unclaimed ones could go anywhere, so they decide it only when they cannot change it. */
        override fun resultIfStoppedNow(): MatchResult {
            result()?.let { return it }
            val left = owners.count { it < 0 }
            val ranked = scores.entries.sortedByDescending { it.value }
            val top = ranked[0]
            val second = ranked.getOrNull(1)?.value ?: 0
            return if (top.value - second > left) MatchResult(Outcome.WINNER, top.key, scores.toMap(), "Stopped with the result already certain.")
            else MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped with boxes still to win.")
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            put("size", size)
            put("lines", JsonArray(drawnBy.map { JsonPrimitive(it) }))
            put("boxes", JsonArray(owners.map { JsonPrimitive(it) }))
            put("lastLine", lastLine)
            val seat = viewer?.let { players.indexOf(it) } ?: -1
            put("mySeat", seat)
            put("myTurn", phase == "playing" && seat >= 0 && seat == turnIndex)
            put("counts", JsonArray(players.map { JsonPrimitive(scores[it] ?: 0) }))
            put("level", level.wire)
        }
    }
}
