package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Who's the Spy? - everybody knows where they are except one person, who has to bluff.
 *
 * Every phone shows the same place and a part to play there, except the spy's, which says
 * only "You're the spy". Players take turns asking each other questions out loud; the
 * phones hold the secrets, the clock and the votes, and nothing else. Anyone may call a
 * vote on anyone, once per round. A strict majority of the other players voting yes ends
 * the round: catch the spy and everybody else wins, accuse an innocent and the spy wins.
 * The spy may instead guess the place at any moment - right wins, wrong loses - and if
 * the clock runs out the spy wins too.
 *
 * PRIVACY. The spy's identity and the place are the whole game. A viewer's snapshot holds
 * their own card and nothing about anybody else's; a spectator gets no card at all. Both
 * are published to everybody only once the round is over.
 */
internal object SpyGame : CampsiteGame {
    override val id = "spy"
    override val title = "Who's the Spy?"
    override val blurb = "Everyone knows the place except the spy. Ask questions, find the bluffer."
    override val kind = "poll"
    override val seats = Seats.of(3, 10)
    override val needsGuests = true
    override val tournamentReady = false
    override val category = GameCategory.PARTY

    const val DEFAULT_MINUTES = 7
    val MINUTES = 3..10

    /** How many places the reference list shows, the real one among them. */
    const val POOL = 20

    /** How long a vote may stay open before the silent are counted as "no". */
    const val VOTE_MS = 45_000L

    override fun validateSetup(text: String) {}

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size in seats.min..seats.max) { "Who's the Spy? needs 3 to 10 players, each on their own phone." }
        val minutes = PartySettings(setup).int("minutes", DEFAULT_MINUTES, MINUTES)
        return Match(players, ctx, minutes)
    }

    /**
     * A bot can only vote and, when it is the spy, take a late guess.
     *
     * It cannot hear the questions being asked round the fire, so it never calls a vote
     * and its "yes" is a coin toss - but it always votes, so a round with a bot in it is
     * never held up waiting on a seat nobody is sitting in. A bot spy guesses from the
     * same public list a human spy is shown, which is a fair long shot.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botStep(playerId, random)

    internal class Match(players: List<String>, ctx: MatchContext, val minutes: Int) : PartyMatch(players, ctx) {

        internal val spy: String = players.random(ctx.random)
        internal val location: SpyLocation = SpyLocations.ALL.random(ctx.random)

        /** The public reference list, sorted, with the real place somewhere in it. */
        internal val pool: List<String> = (SpyLocations.ALL.filter { it != location }.shuffled(ctx.random)
            .take(POOL - 1) + location).map { it.name }.sorted()

        private val roles: Map<String, String> = run {
            val parts = location.roles.shuffled(ctx.random)
            players.filter { it != spy }.mapIndexed { i, id -> id to parts[i % parts.size] }.toMap()
        }

        /** Who has already called their one vote this round. */
        private val accusers = linkedSetOf<String>()

        private var accuser = ""
        private var suspect = ""
        private val votes = linkedMapOf<String, Boolean>()
        private var pausedMs = 0L
        private var spyGuess = ""

        init {
            stage = "asking"
            prompt = "Ask each other questions about the place. Somebody here doesn't know where they are."
            startClock(minutes * 60_000L)
        }

        override fun onApply(move: GameMove) {
            val who = move.playerId
            require(who in present) { "You are watching this round." }
            when (move.action) {
                "accuse" -> accuse(who, move.text("target"))
                "vote" -> vote(who, move.int("choice"))
                "guess" -> guess(who, move.int("choice"))
                else -> throw IllegalArgumentException("Choose an action on your screen.")
            }
        }

        private fun accuse(who: String, target: String) {
            require(stage == "asking") { "A vote is already under way." }
            require(who !in accusers) { "You have already called your vote this round." }
            require(target in present && target != who) { "Choose another player to accuse." }
            accusers.add(who)
            accuser = who
            suspect = target
            votes.clear()
            votes[who] = true
            pausedMs = remainingMs()
            stage = "voting"
            prompt = ctx.nameOf(who) + " thinks " + ctx.nameOf(target) + " is the spy. Vote now."
            note(ctx.nameOf(who) + " accused " + ctx.nameOf(target) + ".")
            startClock(VOTE_MS)
            ctx.nextRound()
            resolveVote(false)
        }

        private fun vote(who: String, choice: Int) {
            require(stage == "voting") { "There is no vote right now." }
            require(who != suspect) { "You can't vote on yourself - make your case out loud." }
            require(choice == 0 || choice == 1) { "Vote yes or no." }
            votes[who] = choice == 1
            resolveVote(false)
        }

        private fun guess(who: String, choice: Int) {
            require(who == spy) { "Only the spy can guess the place." }
            require(stage == "asking" || stage == "voting") { "The round is over." }
            val named = pool.getOrNull(choice) ?: throw IllegalArgumentException("Choose a place from the list.")
            spyGuess = named
            if (named == location.name) {
                note(ctx.nameOf(spy) + " guessed the place: " + named + ".")
                award(spy, 1)
                finish(spyWins = true, "The spy guessed it! " + ctx.nameOf(spy) + " knew it was the " + location.name + ".")
            } else {
                note(ctx.nameOf(spy) + " guessed " + named + ", but it was the " + location.name + ".")
                finish(spyWins = false, "The spy guessed wrong. Everyone else wins!")
            }
        }

        private val eligible: List<String> get() = present.filter { it != suspect }

        /** A strict majority of everybody who may vote. */
        internal val needed: Int get() = eligible.size / 2 + 1

        private fun resolveVote(timedOut: Boolean) {
            if (stage != "voting") return
            val yes = eligible.count { votes[it] == true }
            val no = eligible.count { votes[it] == false }
            val undecided = eligible.size - yes - no
            when {
                yes >= needed -> {
                    note("The vote passed, " + yes + " to " + (eligible.size - yes) + ".")
                    if (suspect == spy) {
                        award(accuser, 1)
                        finish(spyWins = false, "Caught! " + ctx.nameOf(spy) + " was the spy. Everyone else wins!")
                    } else {
                        finish(spyWins = true, ctx.nameOf(suspect) + " wasn't the spy. " + ctx.nameOf(spy) + " was, and gets away with it!")
                    }
                }
                timedOut || yes + undecided < needed -> {
                    note("Not enough votes against " + ctx.nameOf(suspect) + " (" + yes + " yes). Keep asking.")
                    accuser = ""
                    suspect = ""
                    votes.clear()
                    stage = "asking"
                    prompt = "The vote failed. Keep asking questions."
                    startClock(pausedMs.coerceAtLeast(1_000L))
                    ctx.nextRound()
                }
            }
        }

        private fun finish(spyWins: Boolean, message: String) {
            stage = "over"
            accuser = ""
            suspect = ""
            votes.clear()
            val team = if (spyWins) setOf(spy) else players.filter { it != spy }.toSet()
            // A spy who gets away with it has beaten the whole table, so it is worth more.
            if (spyWins) award(spy, 1)
            settleTeam(team, message)
        }

        override fun onTimeUp() {
            when (stage) {
                "asking" -> {
                    note("Time ran out.")
                    finish(spyWins = true, "Time's up! " + ctx.nameOf(spy) + " was the spy and was never caught.")
                }
                "voting" -> resolveVote(true)
            }
        }

        override fun onLeft(playerId: String) {
            when {
                playerId == spy -> abandon("The spy left the game, so this round has no result.")
                present.size < SpyGame.seats.min -> abandon("Too few players are left. Start a new round.")
                // Nobody left to accuse: the vote simply fails and the clock picks up again.
                stage == "voting" && playerId == suspect -> {
                    votes.clear()
                    resolveVote(true)
                }
                else -> resolveVote(false)
            }
        }

        override fun hasAnswered(playerId: String): Boolean =
            stage == "voting" && (playerId == suspect || playerId in votes)

        override fun waitingOn(): List<String> = when {
            phase == "done" -> emptyList()
            stage == "voting" -> eligible.filter { it !in votes }
            else -> present
        }

        override fun resultIfStoppedNow(): MatchResult =
            result() ?: MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped before the spy was found.")

        override fun JsonObjectBuilder.decorateParty(viewer: String?) {
            val over = phase == "done"
            put("minutes", minutes)
            put("pool", JsonArray(pool.map { JsonPrimitive(it) }))
            put("accusers", JsonArray(accusers.map { JsonPrimitive(it) }))
            put("accuser", accuser)
            put("suspect", suspect)
            put("yes", votes.values.count { it })
            put("no", votes.values.count { !it })
            put("needed", if (stage == "voting") needed else 0)
            put("voters", if (stage == "voting") eligible.size else 0)
            put("voted", JsonArray(votes.keys.map { JsonPrimitive(it) }))
            put("myVote", viewer?.let { v -> votes[v]?.let { if (it) 1 else 0 } } ?: -1)
            put("canAccuse", viewer != null && stage == "asking" && viewer !in accusers)
            // THE SECRET. Your own card only, and a spectator has no card.
            put("mySpy", viewer != null && viewer == spy)
            put("myLocation", if (viewer != null && viewer != spy) location.name else "")
            put("myRole", viewer?.let { roles[it] }.orEmpty())
            if (over) {
                put("spy", spy)
                put("location", location.name)
                put("spyGuess", spyGuess)
                put("roles", buildJsonObject { roles.forEach { (id, role) -> put(id, role) } })
            }
        }

        fun botStep(playerId: String, random: Random): GameMove? {
            if (phase != "playing" || playerId !in present) return null
            if (stage == "voting") {
                if (playerId == suspect || playerId in votes) return null
                val yes = if (playerId == spy) true else random.nextBoolean()
                return botAction(playerId, "vote", "choice", if (yes) 1 else 0)
            }
            if (stage == "asking" && playerId == spy && elapsedFraction() > 0.8 && random.nextInt(6) == 0) {
                return botAction(playerId, "guess", "choice", random.nextInt(pool.size))
            }
            return null
        }
    }
}
