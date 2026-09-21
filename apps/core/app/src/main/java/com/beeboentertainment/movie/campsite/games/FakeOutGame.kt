package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Fake Out - a true fact with a blank, a room full of convincing lies, and one truth.
 *
 * Everybody writes a believable fake answer on their own phone. The fakes and the real
 * answer are then shown together, shuffled, and everybody votes for the one they think
 * is true. Finding the truth scores [TRUTH_POINTS]; every player who picks your fake
 * scores you [FOOL_POINTS].
 *
 * A fake that is really the answer - the same words, a plural, a spelling slip, "8" for
 * "eight" - is refused with a "too close" message before anybody sees it, so nobody can
 * score by writing the truth. Nobody's fake is shown until everybody has written one or
 * the clock runs out, and who wrote what is shown only after the vote.
 */
internal object FakeOutGame : CampsiteGame {
    override val id = "fakeout"
    override val title = "Fake Out"
    override val blurb = "Write a fake answer to a strange true fact, then spot the real one."
    override val kind = "text"
    override val seats = Seats.of(3, 8)
    override val needsGuests = true
    override val tournamentReady = false
    override val category = GameCategory.PARTY

    val ROUNDS = 3..10
    const val DEFAULT_ROUNDS = 5
    val WRITE_SECONDS = listOf(60, 90, 120)
    const val DEFAULT_WRITE = 90
    const val VOTE_MS = 45_000L
    const val RESULTS_MS = 20_000L
    const val TRUTH_POINTS = 2
    const val FOOL_POINTS = 1
    const val MAX_FAKE = 60

    const val TRUTH = "truth"
    const val HOUSE = "house"

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size in seats.min..seats.max) { "Fake Out needs 3 to 8 players, each on their own phone." }
        val s = PartySettings(setup)
        val write = s.int("seconds", DEFAULT_WRITE, 30..180).let { v -> WRITE_SECONDS.minByOrNull { kotlin.math.abs(it - v) }!! }
        return Match(players, ctx, s.int("rounds", DEFAULT_ROUNDS, ROUNDS), write)
    }

    /**
     * A bot writes a fake by borrowing the real answer of a different fact of the same
     * kind - a number for a number, a place for a place - so it reads like a real option
     * without ever being this fact's answer. It votes at random, never for its own.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botStep(playerId, random)

    private val NUMBERS = mapOf(
        "zero" to "0", "one" to "1", "two" to "2", "three" to "3", "four" to "4", "five" to "5",
        "six" to "6", "seven" to "7", "eight" to "8", "nine" to "9", "ten" to "10", "eleven" to "11",
        "twelve" to "12", "thirteen" to "13", "fourteen" to "14", "fifteen" to "15", "sixteen" to "16",
        "seventeen" to "17", "eighteen" to "18", "nineteen" to "19", "twenty" to "20", "thirty" to "30",
        "forty" to "40", "fifty" to "50", "hundred" to "100",
    )

    /** Comparable form: normalized words, number words as digits, no spaces. */
    private fun key(text: String): String =
        PartyText.normalize(text).split(' ').joinToString("") { NUMBERS[it] ?: it }

    /** True when a fake is really the answer, or so near it that picking it is picking the truth. */
    fun tooClose(fake: String, answer: String): Boolean {
        val f = key(fake)
        val a = key(answer)
        if (f.isEmpty() || a.isEmpty()) return false
        if (f == a) return true
        if (a.length >= 3 && f.contains(a)) return true
        val allowed = when {
            a.length >= 9 -> 2
            a.length >= 4 -> 1
            else -> 0
        }
        return allowed > 0 && PartyText.distance(f, a, allowed) <= allowed
    }

    internal class Option(val text: String, val authors: MutableList<String>, val truth: Boolean)

    internal class Match(
        players: List<String>,
        ctx: MatchContext,
        val rounds: Int,
        val writeSeconds: Int,
    ) : PartyMatch(players, ctx) {

        private val deck: List<FakeOutFact> = FakeOutFacts.ALL.shuffled(ctx.random).take(rounds)
        internal var index = -1
        internal val fact: FakeOutFact get() = deck[index]

        internal val fakes = linkedMapOf<String, String>()
        internal var options: List<Option> = emptyList()
        internal val votes = linkedMapOf<String, Int>()
        private val gained = linkedMapOf<String, Int>()

        init {
            nextFact()
        }

        private fun name(id: String) = ctx.nameOf(id)

        private fun nextFact() {
            index++
            if (index >= deck.size) {
                stage = "over"
                settlePoints("That's the last fact! Final scores are in.")
                return
            }
            fakes.clear()
            options = emptyList()
            votes.clear()
            gained.clear()
            stage = "writing"
            prompt = fact.prompt
            startClock(writeSeconds * 1000L)
            ctx.nextRound()
        }

        override fun onApply(move: GameMove) {
            val who = move.playerId
            require(who in present) { "You are watching this game." }
            when (move.action) {
                "fake" -> writeFake(who, move.text())
                "vote" -> vote(who, move.int("choice"))
                "next" -> {
                    require(who == ctx.leader()) { "The leader moves the game on." }
                    require(stage == "results") { "Wait for the results first." }
                    stopClock()
                    nextFact()
                }
                else -> throw IllegalArgumentException("Choose an action on your screen.")
            }
        }

        private fun writeFake(who: String, raw: String) {
            require(stage == "writing") { "Writing time is over." }
            val text = raw.filter { !it.isISOControl() }.trim().replace(Regex("\\s+"), " ").take(MAX_FAKE)
            require(text.isNotEmpty()) { "Write a fake answer." }
            require(!tooClose(text, fact.answer)) { "Too close to the real answer! Try something else." }
            require(fakes.none { (id, other) -> id != who && key(other) == key(text) }) { "Someone already wrote that. Try something else." }
            fakes[who] = text
            if (present.all { it in fakes }) startVoting()
        }

        private fun startVoting() {
            if (stage != "writing") return
            val list = mutableListOf<Option>()
            fakes.forEach { (id, text) -> list.add(Option(text, mutableListOf(id), truth = false)) }
            list.add(Option(fact.answer, mutableListOf(), truth = true))
            // Too few fakes makes the vote a giveaway, so the house adds believable ones.
            decoys(2 - fakes.size, ctx.random).forEach { list.add(Option(it, mutableListOf(HOUSE), truth = false)) }
            options = list.shuffled(ctx.random)
            stage = "voting"
            prompt = fact.prompt
            startClock(VOTE_MS)
            ctx.nextRound()
        }

        /** Real answers to other facts of the same kind, never close to this one or to a fake. */
        internal fun decoys(count: Int, random: Random): List<String> {
            if (count <= 0) return emptyList()
            val taken = fakes.values.map { key(it) }.toMutableSet()
            val same = FakeOutFacts.ALL.filter { it.kind == fact.kind && it != fact }.map { it.answer }
            val any = FakeOutFacts.ALL.filter { it != fact }.map { it.answer }
            val out = mutableListOf<String>()
            for (candidate in same.shuffled(random) + any.shuffled(random)) {
                if (out.size >= count) break
                if (tooClose(candidate, fact.answer) || key(candidate) in taken) continue
                taken.add(key(candidate))
                out.add(candidate)
            }
            return out
        }

        private fun vote(who: String, choice: Int) {
            require(stage == "voting") { "Voting isn't open." }
            val option = options.getOrNull(choice) ?: throw IllegalArgumentException("Choose one of the answers.")
            require(who !in option.authors) { "That's your own fake! Pick another." }
            votes[who] = choice
            if (present.all { it in votes }) showResults()
        }

        private fun showResults() {
            if (stage != "voting") return
            votes.forEach { (voter, choice) ->
                val option = options[choice]
                if (option.truth) gain(voter, TRUTH_POINTS)
                else option.authors.filter { it in players }.forEach { gain(it, FOOL_POINTS) }
            }
            val found = votes.count { options[it.value].truth }
            note("\"" + fact.answer + "\" - " + found + " found the truth.")
            stage = "results"
            prompt = fact.prompt.replace("____", fact.answer)
            startClock(RESULTS_MS)
            ctx.nextRound()
        }

        private fun gain(id: String, points: Int) {
            award(id, points)
            gained[id] = (gained[id] ?: 0) + points
        }

        override fun onTimeUp() {
            when (stage) {
                "writing" -> startVoting()
                "voting" -> showResults()
                "results" -> nextFact()
            }
        }

        override fun onLeft(playerId: String) {
            if (present.size < 2) { abandon("Too few players are left. Start a new game."); return }
            when (stage) {
                "writing" -> if (present.all { it in fakes }) startVoting()
                "voting" -> if (present.all { it in votes }) showResults()
            }
        }

        override fun hasAnswered(playerId: String): Boolean = when (stage) {
            "writing" -> playerId in fakes
            "voting" -> playerId in votes
            else -> false
        }

        override fun waitingOn(): List<String> = when {
            phase == "done" -> emptyList()
            stage == "writing" -> present.filter { it !in fakes }
            stage == "voting" -> present.filter { it !in votes }
            else -> listOf(ctx.leader())
        }

        override fun resultIfStoppedNow(): MatchResult =
            result() ?: MatchResult(Outcome.SCORES, topScorer(), scores.toMap(), "Stopped early.")

        override fun JsonObjectBuilder.decorateParty(viewer: String?) {
            val shown = stage == "results" || phase == "done"
            put("question", index + 1)
            put("total", deck.size)
            put("fact", if (index in deck.indices) fact.prompt else "")
            put("written", fakes.size)
            put("votedCount", votes.size)
            put("expected", present.size)
            put("myFake", viewer?.let { fakes[it] }.orEmpty())
            put("myVote", viewer?.let { votes[it] } ?: -1)
            put("answer", if (shown && index in deck.indices) fact.answer else "")
            put("choices", JsonArray(if (stage == "writing") emptyList() else options.mapIndexed { i, o ->
                buildJsonObject {
                    put("text", o.text)
                    put("mine", viewer != null && viewer in o.authors)
                    if (shown) {
                        put("truth", o.truth)
                        put("authors", JsonArray(o.authors.map { JsonPrimitive(it) }))
                        put("voters", JsonArray(votes.filterValues { it == i }.keys.map { JsonPrimitive(it) }))
                    }
                }
            }))
            put("gained", buildJsonObject { if (shown) gained.forEach { (k, v) -> put(k, v) } })
        }

        fun botStep(playerId: String, random: Random): GameMove? {
            if (phase != "playing" || playerId !in present) return null
            return when (stage) {
                "writing" -> if (playerId in fakes) null
                    else decoys(1, random).firstOrNull()?.let { botAction(playerId, "fake", "text", it) }
                "voting" -> if (playerId in votes) null
                    else options.indices.filter { playerId !in options[it].authors }.randomOrNull(random)
                        ?.let { botAction(playerId, "vote", "choice", it) }
                else -> null
            }
        }
    }
}
