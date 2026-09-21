package com.beeboentertainment.movie.campsite.games

import com.beeboentertainment.movie.party.games.TriviaQuestion
import kotlinx.serialization.json.*
import kotlin.random.Random

/** A hand-driven context for the party game tests: the clock only moves when a test moves it. */
internal class TestCtx(seed: Int = 7, var clock: Long = 1_000L) : MatchContext {
    override val random: Random = Random(seed)
    var rounds = 0
    override fun now(): Long = clock
    override fun nameOf(playerId: String): String = playerId
    override fun leader(): String = "p0"
    override fun nextRound() { rounds++ }
    override fun trivia(count: Int): List<TriviaQuestion> = emptyList()
}

internal fun seats(n: Int): List<String> = (0 until n).map { "p$it" }

internal fun mv(player: String, action: String, vararg fields: Pair<String, Any>): GameMove =
    GameMove(player, action, buildJsonObject {
        fields.forEach { (key, value) ->
            when (value) {
                is Int -> put(key, value)
                is Boolean -> put(key, value)
                else -> put(key, value.toString())
            }
        }
    })

internal fun JsonObject.str(key: String): String = this[key]?.jsonPrimitive?.content.orEmpty()
internal fun JsonObject.num(key: String): Int = this[key]?.jsonPrimitive?.int ?: -1
internal fun JsonObject.bool(key: String): Boolean = this[key]?.jsonPrimitive?.boolean ?: false

/** Collects what the service writes to history, so a test can read it back. */
internal class RecordingHistory : CampsiteMatchHistory {
    val records = mutableListOf<MatchRecord>()
    override fun record(record: MatchRecord) { records.add(record) }
    override fun recordChampion(record: ChampionRecord) {}
    override fun recent(limit: Int): List<MatchRecord> = records.reversed().take(limit)
    override fun leaderboard(gameId: String?): List<Standing> =
        CampsiteHistoryStore.standings(records, emptyList(), gameId)
    override fun champions(limit: Int): List<ChampionRecord> = emptyList()
    override fun clear() { records.clear() }
}
