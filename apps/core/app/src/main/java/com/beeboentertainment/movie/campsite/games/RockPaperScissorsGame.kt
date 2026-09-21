package com.beeboentertainment.movie.campsite.games

import kotlin.random.Random

/**
 * Rock Paper Scissors - best of five, both players choose in secret, both are shown at once.
 *
 * WHY THIS EXTENDS [PollMatch] AND WRITES NO PRIVACY CODE OF ITS OWN.
 *
 * The entire game is the simultaneous secret choice. If either player can learn the other's
 * pick before the reveal, there is no game left - the second player simply wins every round
 * for the rest of the journey, and they are sitting close enough to do it. So this file does
 * not implement that guarantee; it inherits the one that already exists and is already used
 * by the quiz and the polls:
 *
 *  - [PollMatch] keeps every answer on the host. The snapshot carries "myAnswer", which is
 *    read out of the answers map with the ASKING VIEWER'S OWN id and no other, so a phone
 *    that asks for the round gets back its own choice and a count of how many people have
 *    chosen. A spectator with no id gets -1.
 *  - The per-option tally is written into the snapshot only once the phase is "revealed" or
 *    "done". Before that it is not in the JSON at all, so there is nothing to read early,
 *    with a crafted request or otherwise.
 *  - The reveal fires by itself the moment the second player commits. Neither player is ever
 *    in a state where the other has committed and they have not.
 *
 * The one thing this file DOES add to that is closing the leader's early reveal. [PollMatch]
 * lets a leader reveal a round before everybody has answered, which is right for a quiz with
 * a slow answerer and wrong here: it would end a round in which one player never chose. So
 * "reveal" is refused outright and a round is revealed by the second choice landing, and by
 * nothing else.
 *
 * Changing your mind before the other player has chosen is allowed, and that is safe for the
 * same reason: you cannot see what you would be changing your mind against.
 *
 * RANKED, unlike War and Snakes and Ladders. The line those two fall on the wrong side of is
 * "the player makes no decisions". Here the player makes one every single round, and against
 * a human being it is a real one - people have patterns and their opponents read them. Best
 * of five is short enough that luck matters, which is what makes it a good five-minute game,
 * not a reason to keep it off the board.
 */
internal object RockPaperScissorsGame : CampsiteGame {
    override val id = "rps"
    override val title = "Rock Paper Scissors"
    override val blurb = "Best of five. Choose in secret and reveal together."
    override val kind = "poll"
    override val seats = Seats.exactly(2)
    override val category = GameCategory.PARTY

    private val THROWS = listOf("Rock", "Paper", "Scissors")

    private const val BEST_OF = 5
    private const val TARGET = 3

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size == 2) { "Rock Paper Scissors is for exactly two players." }
        return Match(players, ctx)
    }

    /**
     * The bot uses the shared poll bot, and that is the point rather than a shortcut.
     *
     * A BOT THAT READ THE OPPONENT'S CHOICE BEFORE THE REVEAL WOULD BE CHEATING, and it
     * would be the easiest cheat in this whole package to write by accident, because the
     * bot runs on the host where the answer is sitting right there. So it does not get the
     * chance: the only thing it calls is [PollMatch.botPollMove], which asks one question
     * about the answers map - "am I in it yet" - and never reads a value out of it, its
     * own or anybody's. The choice it returns is drawn from the host's random and nothing
     * else.
     *
     * Uniform random is also, as it happens, the perfect strategy at this game: nothing can
     * beat it over time and nothing can be read off it. So the honest bot and the strong bot
     * are the same bot, which is a happy place to be.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botPollMove(playerId, random)

    private class Match(players: List<String>, ctx: MatchContext) : PollMatch(players, ctx) {

        private var round = 1

        /** True when the round just revealed was a tie, so the round number does not advance. */
        private var tied = false

        init {
            options = THROWS
            // No right answer, so no correct index. The reveal shows both hands, not a mark.
            correct = -1
            prompt = "Round 1 of " + BEST_OF + ". Choose without letting them see."
            ctx.nextRound()
        }

        override val questionNumber: Int get() = round
        override val questionTotal: Int get() = BEST_OF

        override fun onApply(move: GameMove) {
            require(move.action != "reveal") {
                "Nobody reveals this one - it opens itself when you have both chosen."
            }
            super.onApply(move)
        }

        private fun name(playerId: String): String = ctx.nameOf(playerId)

        private fun note(line: String) {
            log.add(line)
            while (log.size > 10) log.removeAt(0)
        }

        private fun tally(): String =
            name(players[0]) + " " + scoreOf(players[0]) + " - " + scoreOf(players[1]) + " " + name(players[1])

        override fun onReveal() {
            val first = players[0]
            val second = players[1]
            val pickA = answers[first] ?: -1
            val pickB = answers[second] ?: -1
            if (pickA !in THROWS.indices || pickB !in THROWS.indices) {
                // Cannot happen through [apply] - a choice is checked against the options
                // before it is stored - but a round with a missing hand scores nobody.
                tied = true
                prompt = "That round could not be scored. Play it again."
                return
            }
            val shown = name(first) + " played " + THROWS[pickA] + ", " +
                name(second) + " played " + THROWS[pickB] + ". "
            if (pickA == pickB) {
                tied = true
                note(shown + "A tie.")
                prompt = shown + "A tie - play that one again."
                return
            }
            tied = false
            // Rock beats Scissors, Paper beats Rock, Scissors beats Paper: each option beats
            // the one two places along the list, which is the whole rule in one line.
            val victor = if ((pickA + 2) % THROWS.size == pickB) first else second
            award(victor, 1)
            note(shown + name(victor) + " takes round " + round + ".")
            if (scoreOf(victor) >= TARGET) {
                // Finish on the reveal that decided it. Making the leader tap Next to end a
                // match that is plainly over is a tap that can be forgotten, and a forgotten
                // tap is a match a bracket has to time out six minutes later.
                prompt = shown + name(victor) + " wins the match. " + tally()
                settleWinner(victor)
                return
            }
            prompt = shown + name(victor) + " wins the round. " + tally()
        }

        /** The leader has seen the hands and tapped Next. A tie replays the same round number. */
        override fun advance() {
            if (!tied) round++
            tied = false
            answers.clear()
            resumePlaying()
            // The previous round's taps must not land on this one.
            ctx.nextRound()
            prompt = "Round " + round + " of " + BEST_OF + ". Choose."
        }

        /** Rounds already won are earned and stand. Level rounds separate nobody. */
        override fun resultIfStoppedNow(): MatchResult =
            result() ?: MatchResult(
                Outcome.SCORES,
                topScorer(),
                scores.toMap(),
                "Stopped part way through the best of five.",
            )
    }
}
