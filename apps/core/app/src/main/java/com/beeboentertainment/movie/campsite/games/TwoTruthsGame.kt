package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * The rules of Two Truths and a Lie with nothing Android or networked in them, so the
 * vote counting, the scoring and the turn order can be unit-tested on their own.
 */
internal object TwoTruthsRules {

    /** One player's three statements and which of them is the lie (0, 1 or 2). */
    data class Entry(val statements: List<String>, val lie: Int)

    /** What one spotlight turn produced once the lie is revealed. */
    data class Resolution(
        val spotlight: String,
        val lie: Int,
        /** Votes per statement, index for index. */
        val counts: List<Int>,
        /** Voters who picked the lie. */
        val correct: List<String>,
        /** Voters who were fooled - they picked a truth. */
        val fooled: List<String>,
        /** Points each player earned this turn, including zeroes for everyone in [voters]. */
        val points: Map<String, Int>,
    )

    const val CORRECT_POINTS = 1

    /**
     * Clean and check a submitted entry. Throws [IllegalArgumentException] with a
     * message for the player's own screen.
     */
    fun validate(raw: List<String>, lie: Int, mask: Boolean): Entry {
        require(raw.size == 3) { "Write three statements." }
        val cleaned = raw.map { it.filter { c -> !c.isISOControl() }.trim().replace(Regex("\\s+"), " ") }
        require(cleaned.all { it.isNotEmpty() }) { "Fill in all three statements." }
        require(cleaned.all { it.length <= TwoTruthsContent.MAX_STATEMENT }) {
            "Keep each statement to ${TwoTruthsContent.MAX_STATEMENT} characters."
        }
        require(cleaned.map { it.lowercase() }.toSet().size == 3) { "Make the three statements different." }
        require(lie in 0..2) { "Mark which statement is the lie." }
        val shown = if (mask) cleaned.map { CampfireWordFilter.mask(it) } else cleaned
        return Entry(shown, lie)
    }

    /**
     * Who takes the spotlight, in order: seat order, skipping anybody who never wrote
     * an entry. Seat order rather than a shuffle so the circle can see who is next.
     */
    fun turnOrder(players: List<String>, entries: Map<String, Entry>): List<String> =
        players.filter { it in entries }

    /** Everybody votes except the person in the spotlight. */
    fun voters(players: List<String>, spotlight: String): List<String> = players.filter { it != spotlight }

    /**
     * Score one turn: a voter who picks the lie gets [CORRECT_POINTS]; the person in the
     * spotlight gets [foolPoints] for every voter who picked a truth. A player who did
     * not vote earns nothing and fools nobody.
     */
    fun resolve(
        players: List<String>,
        spotlight: String,
        entry: Entry,
        votes: Map<String, Int>,
        foolPoints: Int = 1,
    ): Resolution {
        val eligible = voters(players, spotlight)
        val counted = votes.filterKeys { it in eligible }.filterValues { it in 0..2 }
        val correct = eligible.filter { counted[it] == entry.lie }
        val fooled = eligible.filter { it in counted && counted[it] != entry.lie }
        val points = linkedMapOf<String, Int>()
        points[spotlight] = fooled.size * foolPoints
        eligible.forEach { points[it] = if (it in correct) CORRECT_POINTS else 0 }
        return Resolution(
            spotlight = spotlight,
            lie = entry.lie,
            counts = (0..2).map { i -> counted.values.count { it == i } },
            correct = correct,
            fooled = fooled,
            points = points,
        )
    }

    /** Host settings from the leader's setup string, e.g. "fool=2;mask=off". Unknown keys are ignored. */
    data class Settings(val foolPoints: Int = 1, val mask: Boolean = true)

    fun settings(setup: String): Settings {
        val pairs = setup.split(';', ',').mapNotNull {
            val bits = it.split('=', limit = 2)
            if (bits.size == 2) bits[0].trim().lowercase() to bits[1].trim().lowercase() else null
        }.toMap()
        return Settings(
            foolPoints = pairs["fool"]?.toIntOrNull()?.coerceIn(1, 3) ?: 1,
            mask = pairs["mask"] != "off",
        )
    }
}

/**
 * Two Truths and a Lie - everyone writes three statements on their own phone and
 * secretly marks the lie; then each player takes the spotlight while the rest vote.
 *
 * PRIVATE UNTIL REVEALED: a player's entry (and which one is the lie) is only in that
 * player's own snapshot. During a vote the room sees the spotlight's three statements
 * and a count of votes, never the lie and never who voted for what.
 */
internal object TwoTruthsGame : CampsiteGame {
    override val id = "twotruths"
    override val title = "Two Truths and a Lie"
    override val blurb = "Write three facts about you. One is made up. Can the circle spot it?"
    override val kind = "text"
    override val seats = Seats.of(3, 12)
    override val needsGuests = true
    override val category = GameCategory.PARTY

    /** Everybody writes something private first, so a bracket of auto-started heats makes no sense. */
    override val tournamentReady = false

    /** How many "need ideas?" prompts a writer is shown at a time. */
    private const val IDEAS_SHOWN = 5

    private val BOT_ENTRIES = listOf(
        listOf("I have counted every star in one constellation", "I once beeped at a toaster", "I have been to the Moon"),
        listOf("My favourite colour is blue", "I can hum in two voices at once", "I have never been switched off"),
        listOf("I know a lot of card games", "I have fished in a real lake", "I like games at a campsite"),
    )

    override fun validateSetup(text: String) {
        require(text.length <= 60) { "Those settings are too long." }
    }

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx, TwoTruthsRules.settings(setup))

    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botMove(playerId, random)

    private class Match(
        players: List<String>,
        ctx: MatchContext,
        private val settings: TwoTruthsRules.Settings,
    ) : BaseMatch(players, ctx) {

        /** "write", "vote" or "reveal". */
        private var stage = "write"
        private val entries = linkedMapOf<String, TwoTruthsRules.Entry>()
        private var order: List<String> = emptyList()
        private var spot = 0
        private val votes = linkedMapOf<String, Int>()
        private var last: TwoTruthsRules.Resolution? = null
        private val ideas = mutableMapOf<String, List<String>>()

        init {
            prompt = "Write two true things about you and one lie."
            players.forEach { ideas[it] = TwoTruthsContent.IDEAS.shuffled(ctx.random).take(IDEAS_SHOWN) }
        }

        private val spotlight: String get() = order.getOrElse(spot) { "" }

        override fun onApply(move: GameMove) {
            require(move.playerId in players) { "You are not in this round." }
            when (move.action) {
                "entry" -> {
                    require(stage == "write") { "Writing time is over." }
                    val entry = TwoTruthsRules.validate(
                        listOf(move.text("s0"), move.text("s1"), move.text("s2")),
                        move.int("lie"),
                        settings.mask,
                    )
                    entries[move.playerId] = entry
                    if (players.all { it in entries }) beginVoting()
                }
                "ideas" -> {
                    require(stage == "write") { "Writing time is over." }
                    ideas[move.playerId] = TwoTruthsContent.IDEAS.shuffled(ctx.random).take(IDEAS_SHOWN)
                }
                "begin" -> {
                    require(move.playerId == ctx.leader()) { "Only the leader can start the voting." }
                    require(stage == "write") { "Voting has already started." }
                    require(entries.size >= 2) { "Wait until at least two players have written their statements." }
                    beginVoting()
                }
                "vote" -> {
                    require(stage == "vote") { "Voting is closed." }
                    require(move.playerId != spotlight) { "You're in the spotlight - let the others guess." }
                    val choice = move.int("choice")
                    require(choice in 0..2) { "Pick one of the three statements." }
                    votes[move.playerId] = choice
                    if (TwoTruthsRules.voters(players, spotlight).all { it in votes }) reveal()
                }
                "reveal" -> {
                    require(move.playerId == ctx.leader()) { "Only the leader can reveal." }
                    require(stage == "vote") { "Nothing to reveal yet." }
                    reveal()
                }
                "next" -> {
                    require(move.playerId == ctx.leader()) { "Only the leader can move on." }
                    require(stage == "reveal") { "Reveal the lie first." }
                    if (spot + 1 >= order.size) {
                        stage = "done"
                        settleScores("Everyone has had a turn in the spotlight.")
                    } else {
                        spot++
                        votes.clear()
                        stage = "vote"
                        resumePlaying()
                        announceSpotlight()
                        ctx.nextRound()
                    }
                }
                else -> throw IllegalArgumentException("Unknown game action.")
            }
        }

        private fun beginVoting() {
            order = TwoTruthsRules.turnOrder(players, entries)
            spot = 0
            votes.clear()
            stage = "vote"
            announceSpotlight()
            ctx.nextRound()
        }

        private fun announceSpotlight() {
            turnIndex = players.indexOf(spotlight).coerceAtLeast(0)
            prompt = ctx.nameOf(spotlight) + " is in the spotlight. Which one is the lie?"
        }

        private fun reveal() {
            val entry = entries[spotlight] ?: return
            val result = TwoTruthsRules.resolve(players, spotlight, entry, votes, settings.foolPoints)
            result.points.forEach { (id, points) -> if (points > 0) award(id, points) }
            last = result
            stage = "reveal"
            markRevealed()
            val fooled = result.fooled.size
            log.add(
                ctx.nameOf(spotlight) + "'s lie: \"" + entry.statements[entry.lie] + "\" - " +
                    result.correct.size + " spotted it, " + fooled + (if (fooled == 1) " was fooled." else " were fooled."),
            )
        }

        fun botMove(playerId: String, random: Random): GameMove? = when {
            stage == "write" && playerId !in entries -> {
                val lines = BOT_ENTRIES.random(random)
                GameMove(playerId, "entry", buildJsonObject {
                    put("s0", lines[0]); put("s1", lines[1]); put("s2", lines[2]); put("lie", 2)
                })
            }
            stage == "write" && playerId == ctx.leader() && entries.size >= 2 && players.all { it in entries } ->
                botAction(playerId, "begin")
            stage == "vote" && playerId != spotlight && playerId !in votes ->
                botAction(playerId, "vote", "choice", random.nextInt(3))
            stage == "reveal" && playerId == ctx.leader() -> botAction(playerId, "next")
            else -> null
        }

        override fun hasAnswered(playerId: String): Boolean = when (stage) {
            "write" -> playerId in entries
            "vote" -> playerId in votes
            else -> false
        }

        override fun waitingOn(): List<String> = when (stage) {
            "write" -> players.filter { it !in entries }
            "vote" -> TwoTruthsRules.voters(players, spotlight).filter { it !in votes }
            "reveal" -> listOf(ctx.leader())
            else -> emptyList()
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            put("stage", stage)
            put("spotlight", spotlight)
            put("spot", spot + 1)
            put("spots", order.size)
            put("written", entries.size)
            put("maxLength", TwoTruthsContent.MAX_STATEMENT)
            put("foolPoints", settings.foolPoints)
            put("masked", settings.mask)
            // The viewer's own entry, and nobody else's.
            val mine = viewer?.let { entries[it] }
            if (mine != null) {
                put("myStatements", JsonArray(mine.statements.map { JsonPrimitive(it) }))
                put("myLie", mine.lie)
            }
            if (stage == "write" && viewer != null && viewer in players) {
                put("ideas", JsonArray(ideas[viewer].orEmpty().map { JsonPrimitive(it) }))
            }
            if (stage == "vote" || stage == "reveal") {
                val entry = entries[spotlight]
                put("options", JsonArray(entry?.statements.orEmpty().map { JsonPrimitive(it) }))
                put("answered", votes.size)
                put("expected", TwoTruthsRules.voters(players, spotlight).size)
                put("myAnswer", viewer?.let { votes[it] } ?: -1)
            }
            if (stage == "reveal") {
                val result = last
                if (result != null) {
                    put("correct", result.lie)
                    put("counts", JsonArray(result.counts.map { JsonPrimitive(it) }))
                    put("gained", buildJsonObject { result.points.forEach { (id, p) -> put(id, p) } })
                }
            }
        }
    }
}
