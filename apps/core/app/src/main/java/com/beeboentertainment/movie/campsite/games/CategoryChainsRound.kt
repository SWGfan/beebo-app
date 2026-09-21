package com.beeboentertainment.movie.campsite.games

import kotlin.random.Random

/**
 * Category Chains - name something in the category, in turn, without repeating.
 *
 * Just for fun - nobody's checking. A point per word gives the round a score to read
 * out at the end, but the host cannot tell "otter" from "asdf": there is no dictionary
 * on a phone in a tent and no internet to ask, so the only rule it can actually enforce
 * is no repeats. A score that any string earns is not one a leaderboard should count,
 * which is why this round is unranked, like Story Builder - and, like Story Builder,
 * it therefore never enters a bracket.
 */
internal object CategoryChainsRound : CampsiteGame {
    override val id = "categorychains"
    override val title = "Category Chains"
    override val blurb = "Name something in the category. No repeats. Just for fun - nobody's checking."
    override val kind = "text"
    override val seats = Seats.any(2)
    override val category = GameCategory.WORD_AND_TALK
    override val ranked = false

    private const val LINES = 60

    private val CATEGORIES = listOf(
        "Animals", "Things you take camping", "Foods", "Movie titles", "Places", "Things in nature",
    )

    /**
     * What a bot is allowed to say, per category.
     *
     * Typed out rather than generated because there is no dictionary on this phone and
     * there is no internet: the hotspot has no way out. Twenty-four per category is
     * chosen against the round cap - a round is sixty words in total, so a bot taking
     * every other turn cannot exhaust its own list before the round ends, and if it
     * somehow does (a heat of two bots) it calls time instead of sitting there.
     */
    /**
     * What a bot falls back on when its list is used up.
     *
     * Every one of these reads correctly in front of every category on the list -
     * "Another otter", "One more tent", "A second beach" - which is why they are
     * qualifiers and not extra words. Twenty-four words times four qualifiers is well
     * past the sixty-word round cap, so a bot cannot run out of legal things to say
     * inside one round, and a heat of two bots therefore cannot grind to a halt.
     */
    private val BOT_QUALIFIERS = listOf("Another", "One more", "A second", "Yet another")

    private val BANK: Map<String, List<String>> = mapOf(
        "Animals" to listOf(
            "Otter", "Badger", "Heron", "Hedgehog", "Fox", "Squirrel", "Owl", "Pine marten",
            "Kingfisher", "Toad", "Newt", "Bat", "Deer", "Rabbit", "Mole", "Weasel",
            "Buzzard", "Wren", "Robin", "Pike", "Beetle", "Dragonfly", "Adder", "Stoat",
        ),
        "Things you take camping" to listOf(
            "Tent", "Sleeping bag", "Torch", "Kettle", "Matches", "Map", "Compass", "Boots",
            "Raincoat", "Water bottle", "Camping stove", "Tin opener", "Rope", "Pegs",
            "Mallet", "First aid kit", "Cool box", "Folding chair", "Marshmallows",
            "Spare socks", "Bin bags", "Sun cream", "Midge spray", "Playing cards",
        ),
        "Foods" to listOf(
            "Beans on toast", "Sausages", "Pancakes", "Porridge", "Toasted marshmallow",
            "Apple", "Cheese", "Soup", "Jacket potato", "Fish and chips", "Boiled egg",
            "Peanut butter", "Chocolate bar", "Crisps", "Bacon roll", "Tomato",
            "Rice pudding", "Flapjack", "Banana", "Noodles", "Hot dog", "Crumpet",
            "Scrambled eggs", "Pasta",
        ),
        "Movie titles" to listOf(
            "The Long Way Home", "Night Train", "The Quiet Hill", "Seven Lanterns",
            "Dust and Thunder", "The Paper Boat", "Winter Harbour", "The Last Ferry",
            "Bright Water", "The Glass Orchard", "Comet Road", "A Small Kingdom",
            "The Copper Bell", "Silent Meadow", "Harbour Lights", "The Iron Ladder",
            "Late Summer", "The Blue Hour", "Storm Season", "The Tin Compass",
            "Ten Miles North", "The Painted Sky", "Low Tide", "The Second Morning",
        ),
        "Places" to listOf(
            "Beach", "Castle", "Museum", "Harbour", "Forest", "Waterfall", "Market",
            "Lighthouse", "Farm", "Library", "Cave", "Bridge", "Island", "Valley", "Moor",
            "Pier", "Cathedral", "Canal", "Quarry", "Orchard", "Glen", "Headland",
            "Reservoir", "Bothy",
        ),
        "Things in nature" to listOf(
            "Acorn", "Pebble", "Moss", "Fern", "Puddle", "Thistle", "Pinecone", "Rainbow",
            "Icicle", "Cobweb", "Bramble", "Feather", "Shell", "Driftwood", "Lichen",
            "Toadstool", "Frost", "Snowflake", "Bluebell", "Nettle", "Reed", "Boulder",
            "Mist", "Seaweed",
        ),
    )

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    /**
     * The bot names something in the category that has not been said yet.
     *
     * It cannot repeat, because it checks the SAME used-word set the match enforces -
     * it is filtering its own list, not being told what is left, so it can never send a
     * word the match would reject.
     *
     * The `finish` fallback is there for the one case where a bot is the leader: this
     * game is unranked, so it never enters a bracket, but in free play the round's
     * leader can still be a bot when the room's leader started it and sat back to
     * watch. If that bot has nothing left to say it calls time on the round rather
     * than leaving it sitting on a turn nobody can legally take.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? {
        val round = match as? Match ?: return null
        if (round.phase != "playing") return null
        round.botWord(playerId, random)?.let { return botAction(playerId, "text", "text", it) }
        return if (round.botShouldFinish(playerId)) botAction(playerId, "finish") else null
    }

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {
        private val used = linkedSetOf<String>()
        private val category = CATEGORIES.random(ctx.random)

        init {
            prompt = category
        }

        /**
         * A word from this round's category that nobody has used.
         *
         * It filters against the SAME used-word set the match enforces, so it is not
         * being told what is left - it is checking, exactly as a player does when they
         * try to remember whether somebody already said otter.
         */
        fun botWord(playerId: String, random: Random): String? {
            if (players.getOrNull(turnIndex) != playerId || log.size >= LINES) return null
            val bank = BANK[category].orEmpty()
            if (bank.isEmpty()) return null
            val fresh = bank.filter { it.lowercase().trim() !in used }
            if (fresh.isNotEmpty()) return fresh.random(random)
            val stretched = BOT_QUALIFIERS
                .flatMap { qualifier -> bank.map { qualifier + " " + it.lowercase() } }
                .filter { it.lowercase().trim() !in used }
            return if (stretched.isEmpty()) null else stretched.random(random)
        }

        /**
         * The round is full and this bot is the one running it, so it calls time rather
         * than leaving a heat sitting on a turn nobody can legally take.
         */
        fun botShouldFinish(playerId: String): Boolean =
            playerId == ctx.leader() && log.size >= LINES

        override fun onApply(move: GameMove) {
            when (move.action) {
                "text" -> {
                    val text = GameText.clean(move.text())
                    require(players.getOrNull(turnIndex) == move.playerId) { "Wait for your turn." }
                    require(log.size < LINES) { "This round is full. The leader can finish it." }
                    val normalized = text.lowercase().trim()
                    // The host owns the used-word list. A phone cannot decide its own
                    // repeat was fine, and cannot see the list to mine it either.
                    require(normalized !in used) { "That word has already been used." }
                    used.add(normalized)
                    award(move.playerId, 1)
                    log.add(ctx.nameOf(move.playerId) + ": " + text)
                    turnIndex = (turnIndex + 1) % players.size
                }
                "finish" -> {
                    require(move.playerId == ctx.leader() && phase == "playing") { "Only the leader can finish this round." }
                    require(log.isNotEmpty()) { "Add something first." }
                    settleScores("Most words wins.")
                }
                else -> throw IllegalArgumentException("Unknown game action.")
            }
        }

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))
    }
}
