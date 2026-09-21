package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * 20 Questions - the leader thinks of something, everyone else asks yes-or-no questions.
 *
 * The secret is the sharpest privacy case in the whole engine: it lives on the host,
 * goes into the leader's own snapshot only, and appears to everybody else the instant
 * the round is over and not a moment before. A guessing player's snapshot simply does
 * not contain the field.
 */
internal object TwentyQuestionsRound : CampsiteGame {
    override val id = "twentyquestions"
    override val title = "20 Questions"
    override val blurb = "One secret. Twenty questions to solve it."
    override val kind = "text"
    override val seats = Seats.any(2)
    override val category = GameCategory.WORD_AND_TALK
    override val needsGuests = true

    /** The leader types the secret before the round starts, so it cannot be auto-bracketed. */
    override val needsSetup = true

    private val VERDICTS = listOf("Yes", "No", "Sometimes", "Correct guess!")
    private const val LIMIT = 20

    /** After this many questions a bot starts taking shots at an answer. */
    private const val NARROWING = 6

    /** Narrowing questions a bot asks. Yes-or-no, which is the only rule they must obey. */
    private val BOT_QUESTIONS = listOf(
        "Is it alive?", "Is it bigger than a shoe?", "Can you hold it in one hand?",
        "Is it something you eat?", "Does it make a noise?", "Is it made of metal?",
        "Would you find it indoors?", "Is it something you wear?", "Does it have wheels?",
        "Is it heavier than a kettle?", "Is it soft?", "Is it older than you are?",
        "Would you take it camping?", "Is it wet?", "Does it have a smell?",
        "Can you see it from here?", "Is it expensive?", "Does it come in more than one colour?",
        "Is it something you'd find at home?", "Is it outside right now?",
    )

    /** Actual guesses. The leader is the one who decides whether a guess landed. */
    private val BOT_GUESSES = listOf(
        "Is it a tent?", "Is it a torch?", "Is it a dog?", "Is it a car?", "Is it a tree?",
        "Is it a kettle?", "Is it a boot?", "Is it the moon?", "Is it a sandwich?",
        "Is it a bicycle?", "Is it a river?", "Is it a phone?", "Is it a marshmallow?",
        "Is it a sleeping bag?", "Is it a bird?", "Is it a cloud?",
    )

    override fun validateSetup(text: String) {
        require(text.trim().length in 1..100) { "The leader needs to choose a secret first." }
    }

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx, setup.trim().take(100))

    /**
     * The bot asks, and later guesses. It never answers.
     *
     * A BOT CAN ONLY EVER BE A GUESSER HERE, and that is structural rather than a
     * choice: the leader is the one who typed the secret, a bot cannot type a secret,
     * and the room leader is always a real person (the service never hands the
     * leadership of a room to a bot). It also means the bot cannot read the secret -
     * [Match.secret] is behind the same leader check the human views use, and the bot
     * is asking the match for a QUESTION, never for the answer.
     *
     * It genuinely cannot reason about a freely typed secret, so it narrows for a few
     * turns and then starts guessing common things. Sometimes it gets there; usually
     * the secret holds out and the leader takes the round at twenty, which is a real
     * outcome of the real rules. The alternative - no bot at all - means a seat that
     * never asks anything, and a round with one bot guesser would simply never move.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? {
        val round = match as? Match ?: return null
        val question = round.botQuestion(playerId, random) ?: return null
        return botAction(playerId, "text", "text", question)
    }

    private class Match(
        players: List<String>,
        ctx: MatchContext,
        private val secret: String,
    ) : BaseMatch(players, ctx) {

        private var pending: Pair<String, String>? = null

        /** What the bots have already asked, so they do not ask the same thing twice. */
        private val botAsked = linkedSetOf<String>()

        init {
            prompt = "Ask up to 20 yes-or-no questions. The leader has chosen a secret."
        }

        override fun onApply(move: GameMove) {
            when (move.action) {
                "text" -> {
                    val text = GameText.clean(move.text())
                    require(move.playerId != ctx.leader()) { "The leader answers the questions." }
                    require(pending == null && log.size < LIMIT) { "Wait for the leader's answer." }
                    pending = move.playerId to text
                }
                "judge" -> {
                    require(move.playerId == ctx.leader() && phase == "playing") { "Only the leader can answer." }
                    val asked = pending ?: throw IllegalArgumentException("Waiting for a question.")
                    val verdict = move.text()
                    require(verdict in VERDICTS) { "Choose an answer." }
                    log.add(ctx.nameOf(asked.first) + ": " + asked.second + " — " + verdict)
                    pending = null
                    if (verdict == "Correct guess!") {
                        award(asked.first, 1)
                        settleWinner(asked.first)
                    } else if (log.size >= LIMIT) {
                        // The secret held out: the leader takes the round.
                        settleWinner(ctx.leader())
                    }
                }
                else -> throw IllegalArgumentException("Unknown game action.")
            }
        }

        /**
         * The next thing a bot should ask, or null when it is not the bot's place to
         * speak - the leader is mid-answer, the round is over, or the twenty are up.
         * Checking `pending` here is what stops two bots in the same room both firing a
         * question into a slot that only holds one.
         */
        fun botQuestion(playerId: String, random: Random): String? {
            if (phase != "playing" || pending != null) return null
            if (playerId == ctx.leader() || log.size >= LIMIT) return null
            val bank = if (log.size < NARROWING || random.nextInt(3) != 0) BOT_QUESTIONS else BOT_GUESSES
            val fresh = bank.filter { it !in botAsked }
            val chosen = (if (fresh.isEmpty()) bank else fresh).random(random)
            botAsked.add(chosen)
            return chosen
        }

        override fun waitingOn(): List<String> = when {
            phase == "done" -> emptyList()
            pending != null -> listOf(ctx.leader())
            else -> players.filter { it != ctx.leader() }
        }

        /** Stopping early means the secret was never guessed, so the leader keeps it. */
        override fun resultIfStoppedNow(): MatchResult =
            result() ?: MatchResult(Outcome.WINNER, ctx.leader(), scores.toMap(), "Nobody guessed it.")

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            if (viewer == ctx.leader() || phase == "done") put("secret", secret)
            put("pending", pending?.let { ctx.nameOf(it.first) + ": " + it.second }.orEmpty())
        }
    }
}
