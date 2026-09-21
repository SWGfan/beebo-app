package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * The rules of Hot Potato with no clock and no Android in them.
 *
 * The engine never reads the time. It hands out a fuse length in milliseconds and the
 * caller - the phone screen, or the host service - decides when that much time has
 * passed and calls [burn]. That keeps the random source and the letter progression
 * testable to the millisecond without sleeping.
 *
 * @param players seat order; the first seat holds the potato first.
 * @param random injected so a test can pin the categories and the fuse.
 */
internal class HotPotatoEngine(
    val players: List<String>,
    private val random: Random,
    val minSeconds: Int = DEFAULT_MIN_SECONDS,
    val maxSeconds: Int = DEFAULT_MAX_SECONDS,
    val word: String = WORD,
    private val categories: List<String> = HotPotatoContent.CATEGORIES,
) {
    init {
        require(players.size >= 2) { "Hot Potato needs at least two players." }
        require(minSeconds in 1..maxSeconds) { "The shortest fuse must be shorter than the longest." }
        require(word.isNotEmpty()) { "The losing word cannot be empty." }
        require(categories.isNotEmpty()) { "No categories to play with." }
    }

    private val letters = players.associateWith { 0 }.toMutableMap()
    private val deck = ArrayDeque<String>()

    var holderIndex: Int = 0
        private set
    var category: String = ""
        private set
    var fuseMs: Long = 0
        private set
    var round: Int = 0
        private set
    /** Who got burned last, or null before the first bang. */
    var lastBurned: String? = null
        private set
    var passes: Int = 0
        private set

    val holder: String get() = players[holderIndex]

    /** True once somebody has spelled the whole word. */
    val over: Boolean get() = letters.values.any { it >= word.length }

    /** The player who spelled the word, or null while the game is still going. */
    val loser: String? get() = players.firstOrNull { (letters[it] ?: 0) >= word.length }

    init {
        startRound()
    }

    fun lettersOf(player: String): Int = letters[player] ?: 0

    /** "", "P", "PO" ... - the part of the word this player has earned. */
    fun spelled(player: String): String = word.take(lettersOf(player))

    /** Hand the potato to the next seat. */
    fun pass() {
        check(!over) { "The game is over." }
        holderIndex = (holderIndex + 1) % players.size
        passes++
    }

    /**
     * The fuse ran out: whoever is holding it takes a letter. Returns who was burned.
     * The next round is not started here, so a screen can show the bang first.
     */
    fun burn(): String {
        check(!over) { "The game is over." }
        val burned = holder
        letters[burned] = lettersOf(burned) + 1
        lastBurned = burned
        return burned
    }

    /** A fresh category and fuse. The person who was burned starts, as the loser of a round usually does. */
    fun startRound() {
        check(!over) { "The game is over." }
        lastBurned?.let { holderIndex = players.indexOf(it).coerceAtLeast(0) }
        category = nextCategory()
        fuseMs = drawFuseMs(random, minSeconds, maxSeconds)
        passes = 0
        round++
    }

    /** Scores for a results table: letters still to lose, so a higher score is better. */
    fun scores(): Map<String, Int> = players.associateWith { (word.length - lettersOf(it)).coerceAtLeast(0) }

    /** Categories come off a shuffled deck, so none repeats until every one has been used. */
    private fun nextCategory(): String {
        if (deck.isEmpty()) deck.addAll(categories.shuffled(random))
        return deck.removeFirst()
    }

    companion object {
        const val WORD = "POTATO"
        const val DEFAULT_MIN_SECONDS = 20
        const val DEFAULT_MAX_SECONDS = 60

        /** A hidden fuse between [minSeconds] and [maxSeconds] inclusive, in whole milliseconds. */
        fun drawFuseMs(random: Random, minSeconds: Int, maxSeconds: Int): Long =
            random.nextLong(minSeconds * 1_000L, maxSeconds * 1_000L + 1)

        /** The host's timer presets, as (label, min seconds, max seconds). */
        val PRESETS = listOf(
            Triple("Short", 10, 25),
            Triple("Normal", 20, 60),
            Triple("Long", 40, 90),
        )

        /** Host settings from a setup string like "timer=short". */
        fun preset(setup: String): Pair<Int, Int> {
            val wanted = Regex("timer=(\\w+)").find(setup.lowercase())?.groupValues?.get(1)
            val hit = PRESETS.firstOrNull { it.first.lowercase() == wanted } ?: PRESETS[1]
            return hit.second to hit.third
        }
    }
}

/**
 * Hot Potato. On one phone (the in-app screen) it is pass-the-phone. In a guest room
 * each phone plays the part of the potato: the holder says an answer and taps Pass,
 * and the potato jumps to the next phone. The fuse is hidden on the host and nobody
 * is told how long it is.
 *
 * The host has no timer thread for this. A phone in the round nudges the host with a
 * no-op "tick" while it is playing, and every action first checks whether the fuse has
 * run out - the same trick Snap uses to close its judging window.
 */
internal object HotPotatoGame : CampsiteGame {
    override val id = "hotpotato"
    override val title = "Hot Potato"
    override val blurb = "Name something in the category, then pass it on before it goes off!"
    override val kind = "claim"
    override val seats = Seats.of(2, 12)
    override val category = GameCategory.PARTY
    override val needsGuests = false
    override val passThePhone = true
    override val localRoute = "hotpotato"

    /** A dropped phone would hold a bracket heat hostage; this is a free-play game. */
    override val tournamentReady = false

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        val (min, max) = HotPotatoEngine.preset(setup)
        return Match(players, ctx, HotPotatoEngine(players, ctx.random, min, max))
    }

    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? {
        val m = match as? Match ?: return null
        return m.botMove(playerId, random)
    }

    private class Match(players: List<String>, ctx: MatchContext, private val engine: HotPotatoEngine) :
        BaseMatch(players, ctx) {

        private var deadline = ctx.now() + engine.fuseMs
        /** "live" while the fuse burns, "bang" between rounds. */
        private var stage = "live"

        init {
            showRound()
            // Everybody starts with the whole word still to lose; a letter costs a point.
            engine.scores().forEach { (id, s) -> award(id, s) }
        }

        private fun showRound() {
            prompt = engine.category
            turnIndex = engine.holderIndex
        }

        /** The fuse runs on the host clock. Called before every action, including the tick. */
        private fun checkFuse() {
            if (stage != "live" || ctx.now() < deadline) return
            val burned = engine.burn()
            stage = "bang"
            log.add(ctx.nameOf(burned) + " was holding it! " + ctx.nameOf(burned) + " now has " + engine.spelled(burned) + ".")
            engine.scores().forEach { (id, s) -> award(id, s - scoreOf(id)) }
            if (engine.over) {
                settleScores(ctx.nameOf(burned) + " spelled " + engine.word + ".")
            } else {
                markRevealed()
                ctx.nextRound()
            }
        }

        override fun onApply(move: GameMove) {
            checkFuse()
            if (phase == "done") return
            when (move.action) {
                "tick" -> Unit
                "pass" -> {
                    require(stage == "live") { "Too late - it already went off!" }
                    require(move.playerId == engine.holder) { "You're not holding the potato." }
                    engine.pass()
                    turnIndex = engine.holderIndex
                }
                "next" -> {
                    require(move.playerId == ctx.leader()) { "Only the leader starts the next round." }
                    require(stage == "bang") { "This round is still going." }
                    engine.startRound()
                    deadline = ctx.now() + engine.fuseMs
                    stage = "live"
                    showRound()
                    resumePlaying()
                    ctx.nextRound()
                }
                else -> throw IllegalArgumentException("Unknown game action.")
            }
        }

        fun botMove(playerId: String, random: Random): GameMove? = when {
            phase == "done" -> null
            stage == "live" && playerId == engine.holder -> botAction(playerId, "pass")
            stage == "live" && random.nextInt(4) == 0 -> botAction(playerId, "tick")
            stage == "bang" && playerId == ctx.leader() -> botAction(playerId, "next")
            else -> null
        }

        override fun waitingOn(): List<String> = when {
            phase == "done" -> emptyList()
            stage == "live" -> listOf(engine.holder)
            else -> listOf(ctx.leader())
        }

        /** Stopped early: fewest letters is ahead, a shared lead is a draw. */
        override fun resultIfStoppedNow(): MatchResult {
            result()?.let { return it }
            val s = engine.scores()
            val best = s.values.maxOrNull() ?: 0
            val leaders = s.filterValues { it == best }.keys
            return if (leaders.size == 1) MatchResult(Outcome.SCORES, leaders.first(), s, "Stopped early.")
            else MatchResult(Outcome.DRAW, "", s, "Stopped early.")
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            put("stage", stage)
            put("holder", engine.holder)
            put("potatoRound", engine.round)
            put("word", engine.word)
            put("burned", engine.lastBurned.orEmpty())
            put("letters", buildJsonObject { players.forEach { put(it, engine.spelled(it)) } })
            put("myTurn", viewer != null && viewer == engine.holder && stage == "live")
        }
    }
}
