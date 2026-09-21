package com.beeboentertainment.movie.campsite.games

import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.SessionStore
import kotlinx.serialization.Serializable

/** One player's line in a saved match. */
@Serializable
internal data class MatchPlayer(
    val name: String,
    val score: Int = 0,
    val won: Boolean = false,
    /**
     * A computer player rather than a guest. Defaulted, so every match saved before
     * bots existed still reads back exactly as it did - an absent field is `false`.
     */
    val bot: Boolean = false,
)

/** One finished match, exactly as the history screen and the leaderboard read it back. */
@Serializable
internal data class MatchRecord(
    val id: String,
    val game: String,
    val title: String,
    val players: List<MatchPlayer> = emptyList(),
    val winner: String = "",
    val outcome: String = "winner",
    val endedAt: Long = 0L,
    val durationMs: Long = 0L,
    val tournament: String = "",
    val round: String = "",
    /** Whether this match counts towards the standings. See [CampsiteHistoryStore]. */
    val rated: Boolean = true,
)

/** Somebody won a whole bracket. */
@Serializable
internal data class ChampionRecord(
    val game: String,
    val title: String,
    val champion: String,
    val players: Int = 0,
    val endedAt: Long = 0L,
)

/** One row of the leaderboard. */
internal data class Standing(
    val name: String,
    val played: Int,
    val wins: Int,
    val draws: Int,
    val losses: Int,
    val championships: Int,
    val winRate: Double,
    val rating: Double,
    val provisional: Boolean,
)

/**
 * Where finished matches go.
 *
 * Split from the store so the engine can be built and unit-tested with no Android
 * context at all - [None] is what a test gets, and nothing in the games or the
 * tournament knows the difference.
 */
internal interface CampsiteMatchHistory {
    fun record(record: MatchRecord)
    fun recordChampion(record: ChampionRecord)
    fun recent(limit: Int): List<MatchRecord>

    /** Standings across everything, or for one game id. */
    fun leaderboard(gameId: String?): List<Standing>

    fun champions(limit: Int): List<ChampionRecord>

    /** Used by the host phone and by tests: forget everything. */
    fun clear()

    object None : CampsiteMatchHistory {
        override fun record(record: MatchRecord) {}
        override fun recordChampion(record: ChampionRecord) {}
        override fun recent(limit: Int): List<MatchRecord> = emptyList()
        override fun leaderboard(gameId: String?): List<Standing> = emptyList()
        override fun champions(limit: Int): List<ChampionRecord> = emptyList()
        override fun clear() {}
    }
}

/**
 * Saved match history and standings, in the app's existing plain SharedPreferences.
 *
 * The mechanism is copied from CampsiteTriviaCache on purpose: one JSON string under
 * one key in `session.plain`, encoded with the app's own Json. No new file, no
 * database, no schema to migrate, and it survives the app being closed and the phone
 * being restarted, which is the whole requirement.
 *
 * IDENTITY IS THE DISPLAY NAME, not the session id. A guest's id is random per session
 * and dies when the host's process does; the name they typed is the only thing that
 * still means something next weekend. Two different people who both type "Dad" will
 * merge - that is the same assumption every other guest-facing part of Campsite Mode
 * already makes, and the alternative is asking strangers at a campsite to make accounts.
 */
internal class CampsiteHistoryStore(private val session: SessionStore) : CampsiteMatchHistory {

    @Serializable
    private data class Book(
        val matches: List<MatchRecord> = emptyList(),
        val champions: List<ChampionRecord> = emptyList(),
    )

    private var book: Book? = null

    private fun load(): Book {
        book?.let { return it }
        val raw = runCatching { session.plain.getString(KEY, null) }.getOrNull()
        val parsed = if (raw.isNullOrBlank() || raw.length > MAX_CHARS) Book()
        else runCatching { ApiClient.JSON.decodeFromString(Book.serializer(), raw) }.getOrDefault(Book())
        book = parsed
        return parsed
    }

    private fun save(next: Book) {
        book = next
        runCatching {
            session.plain.edit().putString(KEY, ApiClient.JSON.encodeToString(Book.serializer(), next)).apply()
        }
    }

    @Synchronized
    override fun record(record: MatchRecord) {
        // Re-read before appending: the offline campfire screens write through their own
        // store instance, and a cached book here would otherwise overwrite their records.
        book = null
        val current = load()
        save(current.copy(matches = (current.matches + record).takeLast(MAX_MATCHES)))
    }

    @Synchronized
    override fun recordChampion(record: ChampionRecord) {
        val current = load()
        save(current.copy(champions = (current.champions + record).takeLast(MAX_CHAMPIONS)))
    }

    @Synchronized
    override fun recent(limit: Int): List<MatchRecord> =
        load().matches.takeLast(limit.coerceIn(1, MAX_MATCHES)).reversed()

    @Synchronized
    override fun champions(limit: Int): List<ChampionRecord> =
        load().champions.takeLast(limit.coerceIn(1, MAX_CHAMPIONS)).reversed()

    @Synchronized
    override fun clear() = save(Book())

    @Synchronized
    override fun leaderboard(gameId: String?): List<Standing> = standings(load(), gameId)

    companion object {
        private const val KEY = "campsite_match_history_v1"
        private const val MAX_MATCHES = 500
        private const val MAX_CHAMPIONS = 200
        private const val MAX_CHARS = 1_000_000

        /**
         * A player needs this many rated matches before they are ranked rather than
         * listed as provisional. Two games is not a season.
         */
        const val MIN_RATED = 3

        /**
         * The shrink. A new player starts as if they had already played [PRIOR_MATCHES]
         * matches and won [PRIOR_POINTS] of them - an even record - so one lucky win
         * cannot out-rank a long good run.
         */
        private const val PRIOR_POINTS = 1.0
        private const val PRIOR_MATCHES = 2.0

        private fun key(name: String) = name.trim().lowercase()

        /**
         * WHY NOT RAW WINS: the owner asked for a championship table, and a table sorted
         * by win count is really a table sorted by who played most - the guest who was
         * there all weekend beats the guest who turned up on Sunday and won everything.
         * Sorting by bare win *rate* is the opposite mistake: one win out of one match
         * is 100%.
         *
         * So the rank is a shrunk win rate: points are wins plus half a point per draw,
         * and everybody carries a small even-record prior. Play more and your real form
         * pulls the number away from 50%; play twice and you sit near the middle where
         * you belong. Walkovers are recorded in history but never rated, because nobody
         * learns anything about you from the other player's phone going flat, and games
         * whose winner is a raffle or who have no winner at all are never rated either.
         *
         * Championships are counted and shown, and they break ties, but they do not lead
         * the sort: a bracket win already paid out in the matches won on the way to it,
         * and ranking on trophies alone would reward whoever entered the brackets with
         * only three people in them.
         */
        fun standings(matches: List<MatchRecord>, champions: List<ChampionRecord>, gameId: String?): List<Standing> {
            val played = linkedMapOf<String, Int>()
            val wins = linkedMapOf<String, Int>()
            val draws = linkedMapOf<String, Int>()
            val display = linkedMapOf<String, String>()
            matches.filter { gameId == null || it.game == gameId }.forEach { match ->
                match.players.forEach { player ->
                    val id = key(player.name)
                    if (id.isBlank()) return@forEach
                    // A bot is not a member of the household and never appears in the
                    // table - not even as a name with no record against it. See the
                    // rated flag on the match itself for the other half of this.
                    if (player.bot) return@forEach
                    display[id] = player.name
                    if (!match.rated) return@forEach
                    played[id] = (played[id] ?: 0) + 1
                    when {
                        match.outcome == "draw" -> draws[id] = (draws[id] ?: 0) + 1
                        player.won -> wins[id] = (wins[id] ?: 0) + 1
                    }
                }
            }
            val trophies = linkedMapOf<String, Int>()
            champions.filter { gameId == null || it.game == gameId }.forEach {
                val id = key(it.champion)
                if (id.isNotBlank()) {
                    trophies[id] = (trophies[id] ?: 0) + 1
                    if (id !in display) display[id] = it.champion
                }
            }
            return display.keys.map { id ->
                val games = played[id] ?: 0
                val won = wins[id] ?: 0
                val drew = draws[id] ?: 0
                val points = won + drew * 0.5
                Standing(
                    name = display[id].orEmpty(),
                    played = games,
                    wins = won,
                    draws = drew,
                    losses = (games - won - drew).coerceAtLeast(0),
                    championships = trophies[id] ?: 0,
                    winRate = if (games == 0) 0.0 else won.toDouble() / games,
                    rating = (points + PRIOR_POINTS) / (games + PRIOR_MATCHES),
                    provisional = games < MIN_RATED,
                )
            }.sortedWith(
                compareBy<Standing> { it.provisional }
                    .thenByDescending { it.rating }
                    .thenByDescending { it.championships }
                    .thenByDescending { it.played }
                    .thenBy { it.name.lowercase() },
            )
        }
    }

    private fun standings(source: Book, gameId: String?): List<Standing> =
        standings(source.matches, source.champions, gameId)
}
