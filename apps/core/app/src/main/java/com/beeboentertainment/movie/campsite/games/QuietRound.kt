package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/** The Quiet Game - everyone who makes a sound taps out; the last one left wins. */
internal object QuietRound : CampsiteGame {
    override val id = "quiet"
    override val title = "The Quiet Game"
    override val blurb = "Stay quiet. Last player wins."
    override val kind = "claim"
    override val seats = Seats.any(2)
    override val category = GameCategory.PARTY
    override val needsGuests = true

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    /**
     * The bot eventually makes a sound.
     *
     * A bot has no mouth, so on the letter of the rules it would win every single
     * round by never tapping out - which makes the game pointless for the children it
     * exists for. One chance in eight per think keeps it quiet for a while and then
     * takes it out, so it behaves like another player rather than an immovable wall.
     * Tapping out is its only legal action and the match ignores a second one, so this
     * can never be an illegal move.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? {
        val round = match as? Match ?: return null
        if (round.phase != "playing" || round.hasAnswered(playerId)) return null
        return if (random.nextInt(8) == 0) botAction(playerId, "claim") else null
    }

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {
        private val out = linkedSetOf<String>()

        init {
            prompt = "Stay quiet! Tap ‘I'm out’ when you make a sound. Last quiet player wins."
        }

        override fun onApply(move: GameMove) {
            require(move.action == "claim") { "Choose a game action." }
            require(phase == "playing") { "This round has finished." }
            out.add(move.playerId)
            val remaining = players.filter { it !in out }
            if (remaining.size == 1) {
                award(remaining.first(), 1)
                settleWinner(remaining.first())
            }
        }

        override fun hasAnswered(playerId: String): Boolean = playerId in out

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else players.filter { it !in out }

        /** Nobody can be separated if the round is stopped while several are still quiet. */
        override fun resultIfStoppedNow(): MatchResult {
            val remaining = players.filter { it !in out }
            return result() ?: if (remaining.size == 1) {
                MatchResult(Outcome.WINNER, remaining.first(), scores.toMap(), "Last one quiet.")
            } else {
                MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped while several were still quiet.")
            }
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            put("answered", out.size)
            put("myAnswer", if (viewer != null && viewer in out) 1 else -1)
        }
    }
}
