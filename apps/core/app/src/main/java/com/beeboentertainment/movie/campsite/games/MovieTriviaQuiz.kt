package com.beeboentertainment.movie.campsite.games

import com.beeboentertainment.movie.party.games.TriviaQuestion
import kotlin.random.Random

/**
 * A five-question quiz built from the host's own movie library.
 *
 * The questions and the correct answers are fetched from the host and never leave it
 * until the reveal - a guest that reads its snapshot mid-question finds the options and
 * nothing else.
 */
internal object MovieTriviaQuiz : CampsiteGame {
    override val id = "trivia"
    override val title = "Movie Trivia"
    override val blurb = "Your host's movie library becomes a quiz."
    override val kind = "poll"
    override val seats = Seats.any(2)
    override val category = GameCategory.PARTY

    private const val QUESTIONS = 5

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        val pack = ctx.trivia(QUESTIONS)
        // Thrown before anything is committed, so a host with an empty cache keeps the
        // lobby they were looking at instead of an empty round.
        require(pack.isNotEmpty()) {
            "No movie questions are cached yet. On the host phone, open Movies while connected to the Beebo computer, then try again."
        }
        return Match(players, ctx, pack)
    }

    /** Guesses an option, and runs the round on when the heat leader happens to be a bot. */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botPollMove(playerId, random)

    private class Match(
        players: List<String>,
        ctx: MatchContext,
        private val pack: List<TriviaQuestion>,
    ) : PollMatch(players, ctx) {

        private var index = 0

        init {
            ask()
        }

        private fun ask() {
            val question = pack[index]
            prompt = question.prompt
            options = question.options.map { it.label }
            correct = question.options.indexOfFirst { it.id == question.correctId }
            answers.clear()
            // A new question means an in-flight tap from the old one must not land.
            ctx.nextRound()
        }

        override fun onReveal() {
            answers.forEach { (id, choice) -> if (choice == correct) award(id, 1) }
        }

        override fun advance() {
            if (index + 1 < pack.size) {
                index++
                resumePlaying()
                ask()
            } else {
                settleScores()
            }
        }

        override val questionNumber: Int get() = index + 1
        override val questionTotal: Int get() = pack.size
    }
}
