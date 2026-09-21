package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Everybody taps an option, then the answers are revealed together.
 *
 * The reveal is the whole point of the shape: until it happens, a player may see their
 * OWN choice and the number of people who have answered, and nothing else. Who chose
 * what stays on the host until the round says otherwise - these players are sitting in
 * a circle and would happily read each other's snapshot if it told them anything.
 */
internal abstract class PollMatch(
    players: List<String>,
    ctx: MatchContext,
) : BaseMatch(players, ctx) {

    protected var options: List<String> = emptyList()

    /** Index of the right answer, or -1 when the question has no right answer. */
    protected var correct: Int = -1

    protected val answers = linkedMapOf<String, Int>()

    override fun onApply(move: GameMove) {
        when (move.action) {
            "answer" -> {
                val choice = move.int("choice")
                require(phase == "playing" && choice in options.indices) { "This question is closed." }
                answers[move.playerId] = choice
                // Changing your mind is allowed until the last player answers; the
                // reveal happens by itself so nobody has to chase the slow one.
                if (players.all { it in answers }) reveal()
            }
            "reveal" -> {
                require(move.playerId == ctx.leader()) { "Only the game leader can reveal this round." }
                require(phase == "playing") { "This round has finished." }
                reveal()
            }
            "next" -> {
                require(move.playerId == ctx.leader() && phase == "revealed") { "Wait for the results first." }
                advance()
            }
            else -> throw IllegalArgumentException("Unknown game action.")
        }
    }

    private fun reveal() {
        if (phase != "playing") return
        markRevealed()
        onReveal()
    }

    /** Score the reveal. Only a game with a right answer has anything to do here. */
    protected open fun onReveal() {}

    /** The leader has pressed next. One-question games simply end. */
    protected open fun advance() {
        settleScores()
    }

    override fun hasAnswered(playerId: String): Boolean = playerId in answers

    override fun waitingOn(): List<String> =
        if (phase == "playing") players.filter { it !in answers } else emptyList()

    override fun resultIfStoppedNow(): MatchResult =
        result() ?: MatchResult(Outcome.SCORES, topScorer(), scores.toMap(), "Stopped before the end.")

    /** 1-based position in a multi-question pack. One-shot polls stay at 1 of 0, as before. */
    protected open val questionNumber: Int get() = 1
    protected open val questionTotal: Int get() = 0

    /**
     * The bot for every poll-shaped game, written once here rather than three times in
     * the games that extend it.
     *
     * IT GUESSES, AND THAT IS THE POINT. A trivia bot must not read [correct] - the
     * correct answer is host state the players cannot see, and a bot that used it would
     * be cheating with the host's own data. So it picks an option, the same as somebody
     * who did not know, and gets one in four right.
     *
     * THE SECOND BRANCH IS THE IMPORTANT ONE. Inside a tournament the heat leader is
     * seat 0, and seat 0 can be a bot. A quiz whose leader never taps "next" simply
     * stops, and the bracket sits there until the stall timer calls it six minutes
     * later. A bot must never be the reason a tournament stalls, so a bot that finds
     * itself running the round runs it.
     */
    internal fun botPollMove(playerId: String, random: Random): GameMove? = when {
        phase == "playing" && playerId !in answers && options.isNotEmpty() ->
            botAction(playerId, "answer", "choice", random.nextInt(options.size))
        phase == "revealed" && playerId == ctx.leader() -> botAction(playerId, "next")
        else -> null
    }

    final override fun JsonObjectBuilder.decorate(viewer: String?) {
        put("question", questionNumber)
        put("total", questionTotal)
        put("options", JsonArray(options.map { JsonPrimitive(it) }))
        put("answered", answers.size)
        // Your own answer, and only your own. A spectator (viewer == null) gets -1.
        put("myAnswer", viewer?.let { answers[it] } ?: -1)
        if (phase == "revealed" || phase == "done") {
            put("correct", correct)
            put("counts", JsonArray(options.indices.map { index ->
                JsonPrimitive(answers.values.count { it == index })
            }))
        }
    }
}
