package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * The scoring rules of Five Dice, with no players in them.
 *
 * The game is the classic five-dice score-sheet game. The trademarked name is never
 * used; "five of a kind" is what the famous box is called here.
 *
 * CATEGORIES (index: name, score):
 *  0-5  Ones..Sixes      the sum of the dice showing that number
 *  6    Three of a kind  the sum of all dice, if three show the same number
 *  7    Four of a kind   the sum of all dice, if four show the same number
 *  8    Full house       25 for three of one number and two of another
 *  9    Small straight   30 for four in a row
 *  10   Large straight   40 for five in a row
 *  11   Five of a kind   50
 *  12   Chance           the sum of all dice
 *
 * BONUSES. 35 when Ones..Sixes add up to 63 or more. And for every further five of a
 * kind after the Five-of-a-kind box already holds 50, a bonus of 100.
 *
 * JOKER RULE, for any five of a kind once the Five-of-a-kind box is filled (with 50 or
 * with 0): it must go in the matching number box if that is still open. If that box is
 * taken, it may go in any open box, and Full house, Small straight and Large straight
 * score their full value. A five of a kind with the Five-of-a-kind box still open can
 * go anywhere, like any other roll.
 */
internal object FiveDiceRules {
    const val CATEGORIES = 13
    const val THREE_KIND = 6
    const val FOUR_KIND = 7
    const val FULL_HOUSE = 8
    const val SMALL_STRAIGHT = 9
    const val LARGE_STRAIGHT = 10
    const val FIVE_KIND = 11
    const val CHANCE = 12
    const val UPPER_BONUS = 35
    const val UPPER_TARGET = 63
    const val FIVE_KIND_BONUS = 100

    val NAMES = listOf(
        "Ones", "Twos", "Threes", "Fours", "Fives", "Sixes",
        "Three of a kind", "Four of a kind", "Full house", "Small straight", "Large straight",
        "Five of a kind", "Chance",
    )

    fun counts(dice: IntArray): IntArray {
        val c = IntArray(7)
        for (d in dice) if (d in 1..6) c[d]++
        return c
    }

    fun isFiveKind(dice: IntArray): Boolean = dice.size == 5 && dice[0] in 1..6 && dice.all { it == dice[0] }

    /** The printed score of [category] for [dice], ignoring the joker rule. */
    fun raw(category: Int, dice: IntArray): Int {
        val c = counts(dice)
        val sum = dice.sum()
        return when (category) {
            in 0..5 -> c[category + 1] * (category + 1)
            THREE_KIND -> if (c.any { it >= 3 }) sum else 0
            FOUR_KIND -> if (c.any { it >= 4 }) sum else 0
            FULL_HOUSE -> if (c.any { it == 3 } && c.any { it == 2 }) 25 else 0
            SMALL_STRAIGHT -> if (run(c) >= 4) 30 else 0
            LARGE_STRAIGHT -> if (run(c) >= 5) 40 else 0
            FIVE_KIND -> if (c.any { it == 5 }) 50 else 0
            CHANCE -> sum
            else -> 0
        }
    }

    private fun run(c: IntArray): Int {
        var best = 0
        var cur = 0
        for (face in 1..6) {
            if (c[face] > 0) { cur++; if (cur > best) best = cur } else cur = 0
        }
        return best
    }

    /** True once the Five-of-a-kind box is filled and this roll is five of a kind. */
    fun jokerApplies(sheet: IntArray, dice: IntArray): Boolean = isFiveKind(dice) && sheet[FIVE_KIND] >= 0

    /** The categories this roll may be written in. */
    fun allowed(sheet: IntArray, dice: IntArray): List<Int> {
        val open = (0 until CATEGORIES).filter { sheet[it] < 0 }
        if (jokerApplies(sheet, dice)) {
            val matching = dice[0] - 1
            if (sheet[matching] < 0) return listOf(matching)
        }
        return open
    }

    /** What writing this roll in [category] scores, joker rule included. Not the bonus. */
    fun score(sheet: IntArray, dice: IntArray, category: Int): Int {
        if (jokerApplies(sheet, dice)) {
            when (category) {
                FULL_HOUSE -> return 25
                SMALL_STRAIGHT -> return 30
                LARGE_STRAIGHT -> return 40
            }
        }
        return raw(category, dice)
    }

    /** The five-of-a-kind bonus this roll earns, whatever box it goes in. */
    fun bonusFor(sheet: IntArray, dice: IntArray): Int =
        if (isFiveKind(dice) && sheet[FIVE_KIND] == 50) FIVE_KIND_BONUS else 0

    fun upperTotal(sheet: IntArray): Int = (0..5).sumOf { sheet[it].coerceAtLeast(0) }

    fun upperBonus(sheet: IntArray): Int = if (upperTotal(sheet) >= UPPER_TARGET) UPPER_BONUS else 0

    fun total(sheet: IntArray, fiveKindBonuses: Int): Int =
        sheet.sumOf { it.coerceAtLeast(0) } + upperBonus(sheet) + fiveKindBonuses * FIVE_KIND_BONUS

    // ---- the computer ------------------------------------------------------

    /**
     * How much the bot likes writing [points] in [category] now. Points, plus a nudge
     * towards the upper bonus, minus what it costs to burn a box with a zero.
     */
    fun worth(sheet: IntArray, category: Int, points: Int, bonus: Int): Double {
        var v = points.toDouble() + bonus
        if (category in 0..5) {
            val face = category + 1
            val upper = upperTotal(sheet)
            if (upper < UPPER_TARGET) {
                v += (points - 3 * face) * 0.9
                if (upper + points >= UPPER_TARGET) v += UPPER_BONUS * 0.8
            }
        }
        if (points == 0) v -= ZERO_COST[category]
        if (category == CHANCE) v -= 6.0
        return v
    }

    private val ZERO_COST = doubleArrayOf(0.5, 1.5, 3.0, 4.0, 5.0, 6.0, 9.0, 5.0, 10.0, 12.0, 11.0, 4.0, 20.0)

    fun bestCategory(sheet: IntArray, dice: IntArray): Int =
        allowed(sheet, dice).maxByOrNull { worth(sheet, it, score(sheet, dice, it), bonusFor(sheet, dice)) } ?: -1

    private fun bestWorth(sheet: IntArray, dice: IntArray): Double =
        allowed(sheet, dice).maxOfOrNull { worth(sheet, it, score(sheet, dice, it), bonusFor(sheet, dice)) } ?: 0.0

    /**
     * The expected-value player. Returns the mask of dice to KEEP (bit i = die i), or -1
     * to stop rolling and score now. [rollsLeft] is 1 or 2.
     *
     * It is exact, not sampled: rerolled dice are enumerated as multisets with their
     * multinomial probabilities, and every intermediate value is memoised by the sorted
     * dice, so the whole decision is a few thousand small evaluations.
     */
    fun chooseHold(sheet: IntArray, dice: IntArray, rollsLeft: Int): Int {
        val memoValue = HashMap<Int, Double>()
        val memoEv1 = HashMap<Int, Double>()
        val memoBest1 = HashMap<Int, Double>()

        fun value(full: IntArray): Double = memoValue.getOrPut(key(full)) { bestWorth(sheet, full) }

        fun ev1(held: IntArray): Double = memoEv1.getOrPut(key(held)) {
            var total = 0.0
            for ((outcome, p) in outcomes(5 - held.size)) total += p * value(held + outcome)
            total
        }

        fun best1(full: IntArray): Double = memoBest1.getOrPut(key(full)) {
            var best = value(full)
            for (mask in 0 until 31) best = maxOf(best, ev1(keep(full, mask)))
            best
        }

        fun ev2(held: IntArray): Double {
            var total = 0.0
            for ((outcome, p) in outcomes(5 - held.size)) total += p * best1(held + outcome)
            return total
        }

        val stop = value(dice)
        var bestMask = -1
        var best = stop
        for (mask in 0 until 31) {
            val held = keep(dice, mask)
            val ev = if (rollsLeft >= 2) ev2(held) else ev1(held)
            if (ev > best + 1e-9) { best = ev; bestMask = mask }
        }
        return bestMask
    }

    /** The casual player: keep the most common number (the higher on a tie), or a straight draw. */
    fun casualHold(dice: IntArray): Int {
        val c = counts(dice)
        if (run(c) >= 5) return -1
        if (run(c) >= 4) {
            var mask = 0
            val seen = BooleanArray(7)
            dice.forEachIndexed { i, d -> if (!seen[d]) { seen[d] = true; mask = mask or (1 shl i) } }
            return mask
        }
        var face = 6
        for (f in 6 downTo 1) if (c[f] > c[face]) face = f
        if (c[face] == 5) return -1
        var mask = 0
        dice.forEachIndexed { i, d -> if (d == face) mask = mask or (1 shl i) }
        return mask
    }

    private fun keep(dice: IntArray, mask: Int): IntArray =
        dice.filterIndexed { i, _ -> mask and (1 shl i) != 0 }.toIntArray()

    private fun key(dice: IntArray): Int {
        val c = counts(dice)
        var k = 0
        for (f in 1..6) k = k * 6 + c[f]
        return k * 6 + dice.size
    }

    private val outcomeCache = HashMap<Int, List<Pair<IntArray, Double>>>()

    /** Every multiset of [n] dice with its probability. */
    @Synchronized
    fun outcomes(n: Int): List<Pair<IntArray, Double>> = outcomeCache.getOrPut(n) {
        val out = mutableListOf<Pair<IntArray, Double>>()
        val factorial = IntArray(6) { 1 }.also { for (i in 1..5) it[i] = it[i - 1] * i }
        var totalWays = 1
        repeat(n) { totalWays *= 6 }
        fun build(face: Int, left: Int, acc: MutableList<Int>) {
            if (face > 6 || left == 0) {
                if (left != 0) return
                val c = IntArray(7)
                acc.forEach { c[it]++ }
                var ways = factorial[n]
                for (f in 1..6) ways /= factorial[c[f]]
                out.add(acc.toIntArray() to ways.toDouble() / totalWays)
                return
            }
            for (k in left downTo 0) {
                repeat(k) { acc.add(face) }
                build(face + 1, left - k, acc)
                repeat(k) { acc.removeAt(acc.size - 1) }
            }
        }
        build(1, n, mutableListOf())
        out
    }
}

/**
 * Five Dice: roll five dice up to three times a turn, keeping any you like between
 * rolls, then write the result in one of thirteen boxes. Thirteen turns each; the
 * biggest total wins.
 *
 * WIRE: "hold" with `die` 0..4 toggles a keep; "roll" (optionally with `held`, five
 * characters of 0 and 1) rolls every die not kept; "score" with `category` 0..12.
 * Dice are rolled by the host with the host's random, never by a phone.
 */
internal object FiveDiceGame : CampsiteGame {
    override val id = "fivedice"
    override val title = "Five Dice"
    override val blurb = "Roll, keep, roll again, and fill in your score sheet. One to six players."
    override val kind = "board"
    override val seats = Seats.of(1, 6)
    override val needsGuests = false
    override val category = GameCategory.BOARD

    /** One player is a perfectly good game here, and a bracket still works in heats of six. */
    override val tournamentReady: Boolean get() = true

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.isNotEmpty()) { "Five Dice needs a player." }
        return Match(players.take(6), ctx, TableOptions.parse(setup))
    }

    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? {
        val m = match as? Match ?: return null
        if (m.phase != "playing" || m.players.getOrNull(m.seatToMove) != playerId) return null
        val sheet = m.sheetCopy(m.seatToMove)
        val dice = m.diceCopy()
        val rolls = m.rollsUsed
        if (rolls == 0) return botAction(playerId, "roll")
        if (rolls < 3) {
            val mask = if (m.level == BotLevel.EASY) FiveDiceRules.casualHold(dice)
            else FiveDiceRules.chooseHold(sheet, dice, 3 - rolls)
            if (mask >= 0) {
                val held = (0 until 5).joinToString("") { if (mask and (1 shl it) != 0) "1" else "0" }
                return botAction(playerId, "roll", "held", held)
            }
        }
        return botAction(playerId, "score", "category", FiveDiceRules.bestCategory(sheet, dice))
    }

    internal class Match(players: List<String>, ctx: MatchContext, options: TableOptions) : BaseMatch(players, ctx) {
        val level: BotLevel = options.level
        private val sheets = Array(players.size) { IntArray(FiveDiceRules.CATEGORIES) { -1 } }
        private val bonuses = IntArray(players.size)
        private val dice = IntArray(5)
        private val held = BooleanArray(5)
        var rollsUsed = 0
            private set
        private var lastScored = ""
        private var rollId = 0
        private var rollFaces = emptyList<Int>()
        private var rollKept = emptyList<Boolean>()
        private var rollBy = ""

        val seatToMove: Int get() = turnIndex

        fun sheetCopy(seat: Int): IntArray = sheets[seat].copyOf()
        fun diceCopy(): IntArray = dice.copyOf()

        init {
            prompt = "Roll the dice."
        }

        override fun onApply(move: GameMove) {
            require(phase == "playing") { "This game has finished." }
            val seat = players.indexOf(move.playerId)
            require(seat >= 0) { "You are watching this game." }
            require(seat == turnIndex) { "It is not your turn yet." }
            when (move.action) {
                "hold" -> {
                    require(rollsUsed in 1..2) { if (rollsUsed == 0) "Roll first, then choose dice to keep." else "No rolls left - choose a box to score in." }
                    val die = move.int("die")
                    require(die in 0..4) { "Tap a die to keep it." }
                    held[die] = !held[die]
                }
                "roll" -> {
                    require(rollsUsed < 3) { "That was your third roll - choose a box to score in." }
                    val mask = move.text("held")
                    if (rollsUsed == 0) held.fill(false)
                    else if (mask.length == 5 && mask.all { it == '0' || it == '1' }) for (i in 0..4) held[i] = mask[i] == '1'
                    for (i in 0..4) if (!held[i]) dice[i] = 1 + ctx.random.nextInt(6)
                    rollsUsed++
                    rollId++
                    rollFaces = dice.toList()
                    rollKept = held.toList()
                    rollBy = move.playerId
                    prompt = when (rollsUsed) {
                        3 -> "Choose a box to score in."
                        else -> "Keep any dice you like and roll again, or score now."
                    }
                }
                "score" -> {
                    require(rollsUsed > 0) { "Roll first." }
                    val cat = move.int("category")
                    require(cat in 0 until FiveDiceRules.CATEGORIES) { "Choose a box on your score sheet." }
                    val sheet = sheets[seat]
                    require(sheet[cat] < 0) { "That box is already filled." }
                    val allowed = FiveDiceRules.allowed(sheet, dice)
                    require(cat in allowed) { "Five of a kind has to go in the " + FiveDiceRules.NAMES[dice[0] - 1] + " box while it is open." }
                    val bonus = FiveDiceRules.bonusFor(sheet, dice)
                    val points = FiveDiceRules.score(sheet, dice, cat)
                    sheet[cat] = points
                    if (bonus > 0) bonuses[seat]++
                    scores[move.playerId] = FiveDiceRules.total(sheet, bonuses[seat])
                    val name = ctx.nameOf(move.playerId)
                    lastScored = name + ": " + points + " in " + FiveDiceRules.NAMES[cat] + if (bonus > 0) " and a 100 bonus" else ""
                    note(lastScored)
                    nextTurn(seat)
                }
                else -> throw IllegalArgumentException("Roll, keep some dice, or choose a box.")
            }
        }

        private fun nextTurn(seat: Int) {
            rollsUsed = 0
            held.fill(false)
            dice.fill(0)
            if (sheets.all { s -> s.all { it >= 0 } }) {
                finish()
                return
            }
            turnIndex = (seat + 1) % players.size
            prompt = "Roll the dice."
        }

        private fun finish() {
            players.forEachIndexed { i, p -> scores[p] = FiveDiceRules.total(sheets[i], bonuses[i]) }
            val best = scores.values.maxOrNull() ?: 0
            val leaders = scores.filterValues { it == best }.keys
            if (leaders.size == 1) {
                val w = leaders.first()
                prompt = if (players.size == 1) "Final score: " + best + "." else ctx.nameOf(w) + " wins with " + best + "."
                settleWinner(w)
            } else {
                prompt = "A tie on " + best + "."
                settleDraw("Tied totals.")
            }
        }

        private fun note(line: String) {
            log.add(line)
            if (log.size > 12) log.removeAt(0)
        }

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

        /** Scores so far are real points, so a stopped game goes to the leader on points. */
        override fun resultIfStoppedNow(): MatchResult =
            result() ?: MatchResult(Outcome.SCORES, topScorer(), scores.toMap(), "Stopped before every box was filled.")

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            put("dice", JsonArray(dice.map { JsonPrimitive(it) }))
            put("held", JsonArray(held.map { JsonPrimitive(it) }))
            put("rolls", rollsUsed)
            // Public presentation event. Holding/scoring never invents another roll.
            put("rollId", rollId)
            put("rollFaces", JsonArray(rollFaces.map { JsonPrimitive(it) }))
            put("rollKept", JsonArray(rollKept.map { JsonPrimitive(it) }))
            put("rollBy", rollBy)
            val seat = viewer?.let { players.indexOf(it) } ?: -1
            put("mySeat", seat)
            put("myTurn", phase == "playing" && seat >= 0 && seat == turnIndex)
            put("sheets", JsonArray(sheets.map { s -> JsonArray(s.map { JsonPrimitive(it) }) }))
            put("bonuses", JsonArray(bonuses.map { JsonPrimitive(it) }))
            put("upper", JsonArray(sheets.map { JsonPrimitive(FiveDiceRules.upperTotal(it)) }))
            put("totals", JsonArray(sheets.indices.map { JsonPrimitive(FiveDiceRules.total(sheets[it], bonuses[it])) }))
            // What each open box would score for the player on turn, so the sheet can show it.
            if (phase == "playing" && rollsUsed > 0) {
                val sheet = sheets[turnIndex]
                val allowed = FiveDiceRules.allowed(sheet, dice).toSet()
                put("preview", JsonArray((0 until FiveDiceRules.CATEGORIES).map {
                    JsonPrimitive(if (it in allowed) FiveDiceRules.score(sheet, dice, it) else -1)
                }))
            } else {
                put("preview", JsonArray(emptyList()))
            }
            put("categories", JsonArray(FiveDiceRules.NAMES.map { JsonPrimitive(it) }))
            put("level", level.wire)
        }
    }
}
