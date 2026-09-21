package com.beeboentertainment.movie.campsite.quiz

import com.beeboentertainment.movie.campsite.family.FamilyReply
import com.beeboentertainment.movie.campsite.family.FamilyText
import com.beeboentertainment.movie.campsite.family.RateLimiter
import com.beeboentertainment.movie.campsite.family.intOrNull
import com.beeboentertainment.movie.campsite.family.textOrNull
import com.beeboentertainment.movie.campsite.games.CampsiteMatchHistory
import com.beeboentertainment.movie.campsite.games.MatchPlayer
import com.beeboentertainment.movie.campsite.games.MatchRecord
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.random.Random

/** What the host's own screen needs: the session snapshot (or null when there is none) and how many questions each choice would have. */
internal data class QuizHostState(
    val snapshot: QuizSession.Snapshot?,
    val settings: QuizSettings?,
    val winners: List<String>,
    val aborted: Boolean,
)

/**
 * The quiz as the campsite server and the host phone's screen see it: one session at a time, one
 * lock, a guest-facing JSON view, and the small set of things a guest may do (join, choose a team
 * before the start, answer). Starting, revealing, moving on and stopping belong to the host phone,
 * which calls straight in and never goes through the HTTP door.
 *
 * Finished quizzes are written once to the campsite match history as ONE line (names and scores,
 * not rated, so there is no leaderboard to climb) and counted once towards the "Trivia Rounds x5"
 * badge. Nothing else is stored, and no question, answer or guest name goes anywhere else.
 */
internal class QuizService(
    private val bank: QuizBank,
    private val clock: () -> Long = System::currentTimeMillis,
    private val random: Random = Random.Default,
    private val history: CampsiteMatchHistory = CampsiteMatchHistory.None,
    private val onQuizFinished: () -> Unit = {},
) {
    private var session: QuizSession? = null
    private var recorded = false
    private val recent = LinkedHashSet<String>()
    private val reads = RateLimiter(60, 10_000, clock)
    private val writes = RateLimiter(20, 10_000, clock)

    val problems: List<String> get() = bank.problems

    /** How many questions the packs and age band would draw from. */
    fun available(packs: Set<String>, band: AgeBand?): Int = bank.count(packs, band)

    // ---- host ---------------------------------------------------------------------------

    /** Open a lobby with [settings]. Returns null on success or a message for the host. */
    @Synchronized
    fun open(settings: QuizSettings): String? {
        val s = settings.normalised()
        val pool = bank.select(s.packs, s.band)
        if (pool.size < 3) return "There are not enough questions for that choice. Pick more packs or All ages."
        val chosen = choose(pool, s.rounds)
        session = QuizSession(s, chosen, random, clock)
        recorded = false
        return null
    }

    /** Fresh questions first, then ones asked recently, so a family rarely meets the same one twice in a trip. */
    private fun choose(pool: List<QuizQuestion>, rounds: Int): List<QuizQuestion> {
        val fresh = pool.filter { it.id !in recent }.shuffled(random)
        val stale = pool.filter { it.id in recent }.shuffled(random)
        return (fresh + stale).take(rounds)
    }

    @Synchronized
    fun start(): String? {
        val s = session ?: return "Open a quiz first."
        return s.start(clock())
    }

    @Synchronized fun reveal(): String? = session?.reveal(clock()) ?: "Open a quiz first."

    @Synchronized
    fun next(): String? {
        val s = session ?: return "Open a quiz first."
        val error = s.next(clock())
        finishIfDone(s)
        return error
    }

    /** Host: stop now. Points so far stand. */
    @Synchronized
    fun end() {
        val s = session ?: return
        s.end(clock())
        finishIfDone(s)
    }

    /** Host: tap the answer for the team whose turn it is (turns mode). */
    @Synchronized
    fun hostAnswer(choice: Int): String? {
        val s = session ?: return "Open a quiz first."
        val turn = s.currentTurn() ?: return "This quiz is played on guests' phones."
        return s.answer(turn.id, choice, clock())
    }

    /** Forget the quiz entirely (back to setup). */
    @Synchronized
    fun close() {
        session?.let { finishIfDone(it) }
        session = null
        recorded = false
    }

    @Synchronized
    fun hostState(): QuizHostState {
        val s = session ?: return QuizHostState(null, null, emptyList(), false)
        val snap = s.snapshot(clock())
        return QuizHostState(snap, s.settings, if (s.phase == QuizPhase.DONE) s.winners() else emptyList(), s.aborted)
    }

    private fun finishIfDone(s: QuizSession) {
        if (s.phase != QuizPhase.DONE || recorded) return
        recorded = true
        recent += s.askedIds
        while (recent.size > RECENT_LIMIT) recent.remove(recent.first())
        // Nothing revealed means nothing was played, so nothing is written.
        if (s.revealedCount == 0) return
        val standings = s.standings()
        val winners = s.winners()
        runCatching {
            history.record(
                MatchRecord(
                    id = "quiz-${s.startedAt}",
                    game = GAME_ID,
                    title = "Roadside Quiz",
                    players = standings.map { MatchPlayer(name = it.name, score = it.score, won = it.name in winners || (s.settings.teams > 0 && it.team in winnerTeams(s, winners))) },
                    winner = if (winners.size == 1 && s.settings.teams == 0) winners[0] else "",
                    outcome = "scores",
                    endedAt = s.endedAt,
                    durationMs = (s.endedAt - s.startedAt).coerceAtLeast(0L),
                    rated = false,
                ),
            )
        }
        runCatching { onQuizFinished() }
    }

    private fun winnerTeams(s: QuizSession, winners: List<String>): Set<Int> =
        (0 until s.settings.teams).filter { "Team " + QuizTeams.NAMES[it] in winners }.toSet()

    // ---- the guest door -----------------------------------------------------------------

    @Synchronized
    fun get(token: String, name: String): FamilyReply {
        if (!reads.allow(token)) return FamilyReply.error(429, "Slow down a little.")
        val s = session
        s?.touch(token, clock())
        return FamilyReply.ok(view(s, token))
    }

    /** POST: `join`, `team` {team}, `answer` {choice, q}. The reply is always the fresh state. */
    @Synchronized
    fun post(token: String, name: String, body: JsonObject): FamilyReply {
        if (!writes.allow(token)) return FamilyReply.error(429, "Slow down a little.")
        val s = session ?: return FamilyReply.error(409, "No quiz is running yet. Ask your host to start one.")
        val now = clock()
        val cleaned = FamilyText.name(name)
        val action = body.textOrNull("action", 20)
        if (action == "join") {
            val error = s.join(token, cleaned, now)
            return if (error == null) FamilyReply.ok(view(s, token)) else FamilyReply.error(409, error)
        }
        if (!s.hasPlayer(token)) {
            val error = s.join(token, cleaned, now)
            if (error != null) return FamilyReply.error(409, error)
        }
        val error: String? = when (action) {
            "team" -> s.setTeam(token, body.intOrNull("team") ?: -1)
            "answer" -> {
                val q = body.intOrNull("q")
                // The page echoes the question number so a slow tap on the old question can never land on the new one.
                if (q != s.snapshot(now).number) "That question has finished."
                else s.answer(token, body.intOrNull("choice") ?: -1, now)
            }
            else -> "Unknown action."
        }
        return if (error == null) FamilyReply.ok(view(s, token)) else FamilyReply.error(409, error)
    }

    private fun view(s: QuizSession?, token: String): JsonObject {
        if (s == null) return buildJsonObject { put("ok", true); put("phase", "idle") }
        val snap = s.snapshot(clock())
        val mine = s.hasPlayer(token)
        return buildJsonObject {
            put("ok", true)
            put("phase", snap.phase.wire)
            put("mode", snap.mode.wire)
            put("number", snap.number)
            put("total", snap.total)
            put("prompt", snap.prompt)
            put("options", JsonArray(snap.options.map { JsonPrimitive(it) }))
            put("correct", snap.correct)
            put("fact", snap.fact)
            put("remainingMs", snap.remainingMs)
            put("timerSeconds", snap.timerSeconds)
            put("answered", snap.answered)
            put("expected", snap.expected)
            put("pack", snap.packTitle)
            put("teamNames", buildJsonArray { snap.teams.forEach { add(JsonPrimitive(it.name)) } })
            put("teams", buildJsonArray {
                snap.teams.forEach { t -> add(buildJsonObject { put("index", t.index); put("name", t.name); put("score", t.score); put("members", t.members) }) }
            })
            put("counts", JsonArray(snap.counts.map { JsonPrimitive(it) }))
            if (mine) put("me", buildJsonObject {
                put("name", s.nameOf(token))
                put("team", s.teamOf(token))
                put("score", s.scoreOf(token))
                put("choice", if (snap.phase == QuizPhase.ASKING) s.choiceOf(token) else -1)
            }) else put("me", JsonNull)
            put("players", buildJsonArray {
                snap.rows.forEach { r ->
                    add(buildJsonObject {
                        put("name", r.name)
                        put("team", r.team)
                        put("score", r.score)
                        put("answered", r.answered)
                        r.right?.let { put("right", it) }
                    })
                }
            })
            if (snap.phase == QuizPhase.DONE) put("winners", JsonArray(s.winners().map { JsonPrimitive(it) }))
        }
    }

    companion object {
        const val GAME_ID = "roadsidequiz"
        private const val RECENT_LIMIT = 200
    }
}
