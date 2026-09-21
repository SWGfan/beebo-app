package com.beeboentertainment.movie.campsite.games

import kotlin.random.Random

/** Two impossible choices. Also a vote, also unranked. */
internal object WouldYouRatherPoll : CampsiteGame {
    override val id = "wouldyourather"
    override val title = "Would You Rather"
    override val blurb = "Big choices, silly debates."
    override val kind = "poll"
    override val seats = Seats.any(2)
    override val category = GameCategory.WORD_AND_TALK
    override val needsGuests = true
    override val ranked = false

    private val PAIRS = listOf(
        listOf("Be able to fly", "Breathe underwater"),
        listOf("Visit space", "Explore the deep sea"),
        listOf("Talk to animals", "Speak every language"),
        listOf("Live in a treehouse", "Live on a boat"),
        listOf("Have a pet wolf", "Have a robot helper"),
    )

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    /** Same as This or That: there is no right answer, so a coin toss is a real answer. */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botPollMove(playerId, random)

    private class Match(players: List<String>, ctx: MatchContext) : PollMatch(players, ctx) {
        init {
            prompt = "Would you rather…"
            options = PAIRS.random(ctx.random)
            ctx.nextRound()
        }
    }
}
