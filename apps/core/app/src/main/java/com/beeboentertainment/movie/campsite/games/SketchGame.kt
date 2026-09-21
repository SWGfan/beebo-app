package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Sketch & Guess - one player draws a secret word on their phone, everyone else races to
 * type it.
 *
 * HOW THE DRAWING TRAVELS. There is no socket and no new dependency: the campsite speaks
 * plain JSON over its poll. The drawer's page sends its pen in small batches ("stroke"
 * actions, a few a second while the finger moves), with points already reduced to whole
 * numbers on a 0-1000 grid and thinned so a slow line is not a thousand dots. The host
 * keeps the picture as a list of strokes and every guesser's ordinary 900 ms poll carries
 * it; the page draws only what is new since its last look, and starts again from scratch
 * only when [sketchRev] moves (an undo or a clear). Hard caps on points and strokes keep a
 * snapshot small enough for a hotspot however long somebody scribbles.
 *
 * THE WORD is in the drawer's own snapshot and nobody else's until the turn ends.
 * Guessers see its shape (letters as blanks, spaces kept) and, late in the turn, its
 * first letter. A guess is matched forgivingly - case, spaces, punctuation and a plural
 * do not matter - and a wrong guess that CONTAINS the answer is shown only to the person
 * who typed it, so nobody can win by reading the chat.
 */
internal object SketchGame : CampsiteGame {
    override val id = "sketch"
    override val title = "Sketch & Guess"
    override val blurb = "Draw the secret word on your phone. Everyone else races to guess it."
    override val kind = "text"
    override val seats = Seats.of(3, 8)
    override val needsGuests = true
    override val needsTouch = true
    override val tournamentReady = false
    override val category = GameCategory.PARTY

    val ROUNDS = 1..3
    const val DEFAULT_ROUNDS = 2
    val SECONDS = listOf(60, 80, 100, 120)
    const val DEFAULT_SECONDS = 80
    val LEVELS = listOf("easy", "medium", "hard", "mixed")

    const val REVEAL_MS = 6_000L
    const val MAX_BATCH = 300
    const val MAX_POINTS = 12_000
    const val MAX_STROKES = 400
    const val COLOURS = 10
    const val SIZES = 4
    const val GRID = 1000

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size in seats.min..seats.max) { "Sketch & Guess needs 3 to 8 players, each on their own phone." }
        val s = PartySettings(setup)
        val seconds = s.int("seconds", DEFAULT_SECONDS, 30..180).let { v -> SECONDS.minByOrNull { kotlin.math.abs(it - v) }!! }
        return Match(players, ctx, s.int("rounds", DEFAULT_ROUNDS, ROUNDS), seconds, s.choice("level", "mixed", LEVELS))
    }

    /**
     * A bot never draws - it has no hand - so its turns to draw are passed over. It does
     * guess, from the same public word list for this turn's difficulty that any player
     * could read in the rules, never from the word itself. It is right about as often as
     * a random guess deserves to be, which is rarely.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botStep(playerId, random)

    /** True when [guess] names [word], forgiving case, spacing, punctuation and plurals. */
    fun matches(guess: String, word: String): Boolean = PartyText.same(guess, word)

    /** A wrong guess that still gives the answer away, so it must not be shown to others. */
    fun revealsAnswer(guess: String, word: String): Boolean {
        val g = PartyText.compact(guess)
        val w = PartyText.compact(word)
        return w.length >= 3 && g.contains(w)
    }

    /** One letter off a word long enough for that to mean "nearly". */
    fun isClose(guess: String, word: String): Boolean {
        val g = PartyText.compact(guess)
        val w = PartyText.compact(word)
        return w.length >= 5 && g != w && PartyText.distance(g, w, 1) <= 1
    }

    /** "fire truck" -> "_ _ _ _   _ _ _ _ _" with an optional first letter showing. */
    fun mask(word: String, showFirst: Boolean): String = word.mapIndexed { i, ch ->
        when {
            ch == ' ' -> " "
            !ch.isLetterOrDigit() -> ch.toString()
            i == 0 && showFirst -> ch.uppercaseChar().toString()
            else -> "_"
        }
    }.joinToString(" ")

    internal class Stroke(val seq: Int, val colour: Int, val size: Int) {
        val points = mutableListOf<Int>()
    }

    internal class Guess(val player: String, val text: String, val right: Boolean, val hidden: Boolean, val close: Boolean)

    internal class Match(
        players: List<String>,
        ctx: MatchContext,
        val rounds: Int,
        val seconds: Int,
        val level: String,
    ) : PartyMatch(players, ctx) {

        /** Who draws, in order: every seat once per round. Bots are passed over when their turn comes. */
        private val order: List<String> = List(rounds) { players }.flatten()
        private var orderIndex = -1
        private var turnNumber = 0

        internal var drawer = ""
        internal var word = ""
        internal var wordLevel = ""
        private val used = mutableSetOf<String>()
        private var skipped = false

        internal val strokes = mutableListOf<Stroke>()
        private var pointCount = 0
        internal var sketchRev = 0

        private val guesses = mutableListOf<Guess>()
        internal val solved = linkedSetOf<String>()
        private var lastNote = ""

        init {
            nextTurn()
        }

        private fun name(id: String) = ctx.nameOf(id)

        private fun chooseWord() {
            val lists = if (level == "mixed") SketchWords.LEVELS.keys.toList() else listOf(level)
            wordLevel = lists.random(ctx.random)
            val pool = SketchWords.LEVELS.getValue(wordLevel)
            val fresh = pool.filter { it !in used }.ifEmpty { pool }
            word = fresh.random(ctx.random)
            used.add(word)
        }

        /** Seats that can take the pencil: anyone still here. */
        private fun canDraw(id: String) = id !in away

        private fun nextTurn() {
            var next = orderIndex + 1
            while (next < order.size && !canDraw(order[next])) next++
            if (next >= order.size || present.size < 2) {
                finishGame()
                return
            }
            orderIndex = next
            turnNumber++
            drawer = order[next]
            chooseWord()
            skipped = false
            strokes.clear()
            pointCount = 0
            sketchRev++
            guesses.clear()
            solved.clear()
            stage = "drawing"
            prompt = name(drawer) + " is drawing."
            startClock(seconds * 1000L)
            ctx.nextRound()
        }

        private fun finishGame() {
            stage = "over"
            drawer = ""
            settlePoints("That's the last drawing! Final scores are in.")
        }

        private fun endTurn(why: String) {
            if (stage != "drawing") return
            stage = "reveal"
            prompt = why + " The word was \"" + word + "\"."
            note(name(drawer) + " drew \"" + word + "\" - " + solved.size + " guessed it.")
            startClock(REVEAL_MS)
            ctx.nextRound()
        }

        override fun onApply(move: GameMove) {
            val who = move.playerId
            require(who in present) { "You are watching this game." }
            when (move.action) {
                "stroke" -> {
                    requireDrawer(who)
                    addStroke(move.int("s"), move.int("c"), move.int("w"), move.text("p"))
                }
                "undo" -> {
                    requireDrawer(who)
                    if (strokes.isNotEmpty()) {
                        pointCount -= strokes.removeAt(strokes.size - 1).points.size / 2
                        sketchRev++
                    }
                }
                "clear" -> {
                    requireDrawer(who)
                    strokes.clear()
                    pointCount = 0
                    sketchRev++
                }
                "skipword" -> {
                    requireDrawer(who)
                    require(!skipped) { "You've already swapped your word this turn." }
                    require(strokes.isEmpty()) { "You can only swap the word before you start drawing." }
                    skipped = true
                    chooseWord()
                }
                "pass" -> {
                    requireDrawer(who)
                    require(strokes.isEmpty()) { "You've started drawing - keep going!" }
                    note(name(who) + " passed the pencil on.")
                    stopClock()
                    nextTurn()
                }
                "guess" -> guess(who, move.text())
                "next" -> {
                    require(who == ctx.leader()) { "The leader moves the game on." }
                    require(stage == "reveal") { "Wait for this drawing to finish." }
                    stopClock()
                    nextTurn()
                }
                else -> throw IllegalArgumentException("Choose an action on your screen.")
            }
        }

        private fun requireDrawer(who: String) {
            require(stage == "drawing") { "The drawing time is over." }
            require(who == drawer) { "Only " + name(drawer) + " is drawing right now." }
        }

        private fun addStroke(seq: Int, colour: Int, size: Int, raw: String) {
            require(colour in 0 until COLOURS && size in 0 until SIZES) { "Pick a colour and a brush size." }
            val numbers = raw.split(',').mapNotNull { it.trim().toIntOrNull() }
            require(numbers.size % 2 == 0 && numbers.size in 2..MAX_BATCH * 2) { "That part of the drawing didn't arrive. Keep drawing." }
            require(numbers.all { it in 0..GRID }) { "That part of the drawing was off the page." }
            val room = MAX_POINTS - pointCount
            require(room > 0) { "The page is full. Undo or clear to keep drawing." }
            val last = strokes.lastOrNull()
            val target = if (last != null && last.seq == seq) last else {
                require(last == null || seq > last.seq) { "That part of the drawing arrived late." }
                require(strokes.size < MAX_STROKES) { "The page is full. Undo or clear to keep drawing." }
                Stroke(seq, colour, size).also { strokes.add(it) }
            }
            val take = numbers.take(room * 2)
            target.points.addAll(take)
            pointCount += take.size / 2
        }

        private fun guess(who: String, raw: String) {
            require(stage == "drawing") { "Wait for the next drawing." }
            require(who != drawer) { "You're the one drawing!" }
            require(who !in solved) { "You've already got it - no hints for the others!" }
            val text = raw.filter { !it.isISOControl() }.trim().take(40)
            require(text.isNotEmpty()) { "Type a guess." }
            if (matches(text, word)) {
                solved.add(who)
                val left = 1.0 - elapsedFraction()
                val first = solved.size == 1
                award(who, 50 + (50 * left).toInt() + if (first) 10 else 0)
                award(drawer, 20)
                guesses.add(Guess(who, text, right = true, hidden = true, close = false))
                val guessers = present.filter { it != drawer }
                if (guessers.all { it in solved }) {
                    stopClock()
                    endTurn("Everyone got it!")
                }
            } else {
                guesses.add(Guess(who, text, right = false, hidden = revealsAnswer(text, word), close = isClose(text, word)))
                while (guesses.size > 60) guesses.removeAt(0)
            }
        }

        override fun onTimeUp() {
            when (stage) {
                "drawing" -> endTurn("Time's up!")
                "reveal" -> nextTurn()
            }
        }

        override fun onLeft(playerId: String) {
            if (present.size < 2) { abandon("Too few players are left. Start a new game."); return }
            if (stage == "drawing") {
                if (playerId == drawer) {
                    stopClock()
                    endTurn(name(playerId) + " left.")
                } else if (present.filter { it != drawer }.let { g -> g.isNotEmpty() && g.all { it in solved } }) {
                    stopClock()
                    endTurn("Everyone got it!")
                }
            }
        }

        override fun hasAnswered(playerId: String): Boolean = playerId in solved

        override fun waitingOn(): List<String> = when {
            phase == "done" -> emptyList()
            stage == "drawing" -> listOf(drawer)
            else -> listOf(ctx.leader())
        }

        override fun resultIfStoppedNow(): MatchResult =
            result() ?: MatchResult(Outcome.SCORES, topScorer(), scores.toMap(), "Stopped early.")

        override fun JsonObjectBuilder.decorateParty(viewer: String?) {
            val showWord = stage != "drawing" || viewer == drawer
            put("drawer", drawer)
            put("turn", drawer)
            put("turnNumber", turnNumber)
            put("turns", order.size)
            put("rounds", rounds)
            put("seconds", seconds)
            put("level", wordLevel)
            put("word", if (showWord) word else "")
            put("mask", if (stage == "drawing") mask(word, elapsedFraction() >= 0.6) else "")
            put("canSkipWord", viewer == drawer && stage == "drawing" && !skipped && strokes.isEmpty())
            put("sketchRev", sketchRev)
            put("strokes", JsonArray(strokes.map { s ->
                buildJsonArray { add(s.colour); add(s.size); add(s.seq); add(s.points.joinToString(",")) }
            }))
            put("solved", JsonArray(solved.map { JsonPrimitive(it) }))
            put("mySolved", viewer != null && viewer in solved)
            // A wrong guess that gives the answer away is shown only to its author. A right
            // guess is announced to everyone but spelled out only to its author while
            // others are still guessing.
            put("guesses", JsonArray(guesses.filter { g -> g.right || !g.hidden || g.player == viewer }.map { g ->
                buildJsonObject {
                    put("id", g.player)
                    put("right", g.right)
                    put("text", if (g.right && stage == "drawing" && g.player != viewer) "" else g.text)
                    put("close", g.close && g.player == viewer)
                }
            }))
        }

        fun botStep(playerId: String, random: Random): GameMove? {
            if (phase != "playing" || playerId !in present) return null
            // A bot has no hand to draw with, so it passes the pencil on.
            if (stage == "drawing" && playerId == drawer) return botAction(playerId, "pass")
            if (stage != "drawing" || playerId in solved || random.nextInt(3) != 0) return null
            val pool = SketchWords.LEVELS[wordLevel] ?: return null
            return botAction(playerId, "guess", "text", pool.random(random))
        }
    }
}
