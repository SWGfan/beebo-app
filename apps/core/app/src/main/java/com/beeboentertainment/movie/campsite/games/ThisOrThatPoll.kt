package com.beeboentertainment.movie.campsite.games

import kotlin.random.Random

/** Two options, no right answer - the fun is seeing how the room split. */
internal object ThisOrThatPoll : CampsiteGame {
    override val id = "thisorthat"
    override val title = "This or That"
    override val blurb = "Choose a side and reveal the room's votes."
    override val kind = "poll"
    override val seats = Seats.any(2)
    override val category = GameCategory.WORD_AND_TALK
    override val needsGuests = true

    /** A vote is not a contest, so it never feeds the leaderboard. */
    override val ranked = false

    private val PAIRS = listOf(
        listOf("Chocolate", "Vanilla"), listOf("Beach", "Mountains"), listOf("Cats", "Dogs"),
        listOf("Pizza", "Tacos"), listOf("Summer", "Winter"), listOf("Books", "Movies"),
    )

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    /** A bot has no opinion about chocolate, so it picks a side. That is the whole game. */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botPollMove(playerId, random)

    private class Match(players: List<String>, ctx: MatchContext) : PollMatch(players, ctx) {
        init {
            prompt = "This or That"
            options = PAIRS.random(ctx.random)
            ctx.nextRound()
        }
    }
}
