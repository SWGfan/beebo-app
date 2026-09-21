package com.beeboentertainment.movie.campsite.games

import kotlin.random.Random

/** The shapes a 75-ball game can be played for, picked by the host before the first ball. */
internal enum class BingoPattern(val wire: String, val label: String, val describe: String) {
    LINE("line", "Any line", "a full row, column or diagonal"),
    FOUR_CORNERS("corners", "Four corners", "all four corner squares"),
    X("x", "X", "both diagonals"),
    POSTAGE_STAMP("stamp", "Postage stamp", "a 2×2 block in any corner"),
    BLACKOUT("blackout", "Blackout", "every square on the card");

    /** Whether [covered] (card cell indices, free centre included when covered) makes this pattern. */
    fun matches(covered: Set<Int>): Boolean = when (this) {
        LINE -> BingoGrid.hasLine(covered)
        FOUR_CORNERS -> covered.containsAll(CORNERS)
        X -> covered.containsAll(BingoGrid.DIAGONALS.flatten())
        POSTAGE_STAMP -> STAMPS.any { covered.containsAll(it) }
        BLACKOUT -> covered.containsAll((0 until BingoGrid.CELLS).toList())
    }

    companion object {
        val CORNERS = listOf(0, 4, 20, 24)
        val STAMPS = listOf(listOf(0, 1, 5, 6), listOf(3, 4, 8, 9), listOf(15, 16, 20, 21), listOf(18, 19, 23, 24))
        fun of(wire: String?): BingoPattern = entries.firstOrNull { it.wire == wire } ?: LINE
    }
}

/**
 * Classic 75-ball bingo: cards, the caller and the checking, with no clock and no
 * Android, so every rule is unit-tested. Production code passes a SecureRandom-backed
 * [Random]; tests pass a seeded one.
 */
internal object ClassicBingoRules {
    const val BALLS = 75
    const val FREE_NUMBER = 0
    val LETTERS = listOf("B", "I", "N", "G", "O")

    /** The column (0..4) a ball belongs to: B 1-15, I 16-30, N 31-45, G 46-60, O 61-75. */
    fun column(ball: Int): Int = (ball - 1) / 15

    /** "B 7", "O 75". */
    fun label(ball: Int): String = LETTERS[column(ball)] + " " + ball

    /**
     * A standard card, row by row: each column holds five different numbers from its
     * range, and the centre is the free square ([FREE_NUMBER]).
     */
    fun card(random: Random): List<Int> {
        val columns = (0 until 5).map { c -> (c * 15 + 1..c * 15 + 15).shuffled(random).take(5) }
        return (0 until BingoGrid.CELLS).map { i ->
            if (i == BingoGrid.FREE) FREE_NUMBER else columns[i % 5][i / 5]
        }
    }

    /** Cells covered by the balls actually called - marks a player made are never consulted. */
    fun covered(card: List<Int>, called: Set<Int>): Set<Int> =
        card.indices.filter { i -> card[i] == FREE_NUMBER || card[i] in called }.toSet()

    fun wins(card: List<Int>, called: Set<Int>, pattern: BingoPattern): Boolean = pattern.matches(covered(card, called))
}

/** Draws 1..75 without repeats. */
internal class BingoCaller(random: Random) {
    private val order = (1..ClassicBingoRules.BALLS).shuffled(random)
    private var drawn = 0

    val called: List<Int> get() = order.take(drawn)
    val current: Int? get() = if (drawn == 0) null else order[drawn - 1]
    val remaining: Int get() = order.size - drawn

    /** The next ball, or null when all 75 are out. */
    fun next(): Int? = if (drawn >= order.size) null else order[drawn++]
}

/**
 * One game of Classic Bingo: players with 1-4 cards each, the caller, marks, calls of
 * Bingo with a penalty for a false call, and ties on the same ball.
 *
 * TIES: the first valid call opens a "claim window" on that ball. Anybody else who has
 * a valid card before the next ball is drawn also wins. Drawing the next ball (or
 * [finish]) closes the window and ends the game.
 */
internal class ClassicBingoEngine(
    val players: List<String>,
    random: Random,
    val cardsEach: Int = 1,
    val pattern: BingoPattern = BingoPattern.LINE,
    /** How many calls a false Bingo sits out. 0 turns the penalty off. */
    val penaltyCalls: Int = 3,
    /** Players who get no cards - a host who only calls. */
    callersOnly: Set<String> = emptySet(),
) {
    sealed interface Claim {
        object Win : Claim
        data class Penalty(val calls: Int) : Claim
        data class Blocked(val callsLeft: Int) : Claim
        object Closed : Claim
    }

    init {
        require(players.isNotEmpty()) { "Bingo needs a player." }
        require(cardsEach in 1..4) { "Choose 1 to 4 cards." }
        require(penaltyCalls >= 0) { "The penalty cannot be negative." }
    }

    private val caller = BingoCaller(random)
    val cards: Map<String, List<List<Int>>> =
        players.filter { it !in callersOnly }.associateWith { List(cardsEach) { ClassicBingoRules.card(random) } }
    private val marks = cards.mapValues { (_, list) -> List(list.size) { mutableSetOf(BingoGrid.FREE) } }
    private val penaltyUntil = mutableMapOf<String, Int>()
    private val winnerList = mutableListOf<String>()
    private var winningBall = -1

    var finished: Boolean = false
        private set

    val called: List<Int> get() = caller.called
    val calledSet: Set<Int> get() = caller.called.toSet()
    val current: Int? get() = caller.current
    val winners: List<String> get() = winnerList
    val over: Boolean get() = finished

    fun marksOf(player: String, card: Int): Set<Int> = marks[player]?.getOrNull(card).orEmpty()

    /** Calls this player still has to sit out after a false Bingo. */
    fun penaltyLeft(player: String): Int = ((penaltyUntil[player] ?: 0) - caller.called.size).coerceAtLeast(0)

    /** Draw the next ball. If somebody has already won, this closes the game instead and returns null. */
    fun callNext(): Int? {
        check(!finished) { "The game is over." }
        if (winnerList.isNotEmpty()) { finished = true; return null }
        val ball = caller.next()
        if (ball == null) finished = true
        return ball
    }

    /** Toggle a mark. Marking a number that has not been called is allowed; it simply never counts. */
    fun mark(player: String, card: Int, cell: Int) {
        check(!finished) { "The game is over." }
        val set = marks[player]?.getOrNull(card) ?: throw IllegalArgumentException("That card isn't yours.")
        require(cell in 0 until BingoGrid.CELLS && cell != BingoGrid.FREE) { "Choose a square." }
        if (!set.add(cell)) set.remove(cell)
    }

    fun hasValidCard(player: String): Boolean =
        cards[player].orEmpty().any { ClassicBingoRules.wins(it, calledSet, pattern) }

    /** A player shouts Bingo. Checked only against called numbers. */
    fun claim(player: String): Claim {
        if (finished) return Claim.Closed
        if (player in winnerList) return Claim.Win
        if (winningBall >= 0 && caller.called.size != winningBall) return Claim.Closed
        val wait = penaltyLeft(player)
        if (wait > 0) return Claim.Blocked(wait)
        if (!hasValidCard(player)) {
            if (penaltyCalls > 0) penaltyUntil[player] = caller.called.size + penaltyCalls
            return Claim.Penalty(penaltyCalls)
        }
        winnerList.add(player)
        winningBall = caller.called.size
        return Claim.Win
    }

    /** Computer players always daub correctly and call as soon as they have it. Returns who claimed. */
    fun botTurn(bots: Collection<String>): List<String> {
        if (finished) return emptyList()
        val claimed = mutableListOf<String>()
        bots.forEach { bot ->
            val list = cards[bot] ?: return@forEach
            list.forEachIndexed { i, card ->
                val set = marks.getValue(bot)[i]
                card.forEachIndexed { cell, n -> if (n in calledSet) set.add(cell) }
            }
            if (bot !in winnerList && hasValidCard(bot) && claim(bot) == Claim.Win) claimed.add(bot)
        }
        return claimed
    }

    /** End now: whoever has won, has won. */
    fun finish() { finished = true }

    companion object {
        /** Host settings: "cards=2;pattern=x;penalty=0;caller=call". */
        data class Settings(val cards: Int, val pattern: BingoPattern, val penalty: Int, val callerPlays: Boolean)

        fun settings(setup: String): Settings {
            val pairs = setup.lowercase().split(';').mapNotNull {
                val b = it.split('=', limit = 2); if (b.size == 2) b[0].trim() to b[1].trim() else null
            }.toMap()
            return Settings(
                cards = pairs["cards"]?.toIntOrNull()?.coerceIn(1, 4) ?: 1,
                pattern = BingoPattern.of(pairs["pattern"]),
                penalty = pairs["penalty"]?.toIntOrNull()?.coerceIn(0, 10) ?: 3,
                callerPlays = pairs["caller"] != "call",
            )
        }
    }
}
