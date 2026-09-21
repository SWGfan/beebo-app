package com.beeboentertainment.movie.campsite.hunt

import com.beeboentertainment.movie.campsite.family.FamilyReply
import com.beeboentertainment.movie.campsite.family.RateLimiter
import com.beeboentertainment.movie.campsite.family.intOrNull
import com.beeboentertainment.movie.campsite.family.textOrNull
import com.beeboentertainment.movie.trip.TripMomentSink
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.random.Random

/** What the host phone's own screen needs, worked out under the service lock. */
internal data class HuntHostState(
    val phase: HuntPhase?,
    val settings: HuntSettings?,
    val cardTitle: String,
    val cardEmoji: String,
    val layout: HuntLayout,
    val itemCount: Int,
    val rows: List<HuntRow>,
    val winners: List<HuntRow>,
    val pending: List<HuntSession.PendingLine>,
    val players: List<Triple<String, Int, Boolean>>,
    val contributions: List<Pair<String, Int>>,
    val remainingMs: Long,
    val elapsedMs: Long,
    val stoppedByHost: Boolean,
    val timedOut: Boolean,
    val allFinished: Boolean,
    val photoPrompt: String,
    val photoCount: Int,
    val maxPoints: Int,
) {
    companion object {
        val NONE = HuntHostState(
            null, null, "", "", HuntLayout.LIST, 0, emptyList(), emptyList(), emptyList(), emptyList(), emptyList(),
            -1L, 0L, false, false, false, "", 0, 0,
        )
    }
}

/**
 * The hunt as the campsite server and the host phone's screen see it: one hunt at a time, one lock,
 * a guest-facing JSON view, and the small set of things a guest may do (join, choose a team before
 * the start, tick and un-tick an item, say they took the photo of the day). Opening, starting,
 * approving and ending belong to the host phone, which calls straight in and never goes through
 * the HTTP door.
 *
 * WHAT A GUEST IS EVER TOLD. Their own list and ticks, the leaderboard (a nickname or a team, points,
 * counts), the timer, the host's settings and fixed words. Never another player's private token, never
 * another team's list, never a photo or a place. WHAT THE HOST EVER KEEPS. One Trip line and two badge
 * counters when a hunt with at least one find finishes ([HuntRecords]).
 *
 * LIMITS. JSON bodies over 16 KB are refused by the server before this class sees them. Each guest may
 * read 60 times and write 20 times per 10 seconds and tick or un-tick 10 times per 10 seconds; beyond that
 * they get a 429 and the page backs off. A hunt holds at most 24 players.
 */
internal class HuntService(
    private val clock: () -> Long = System::currentTimeMillis,
    private val random: Random = Random.Default,
    private val trip: TripMomentSink = TripMomentSink.None,
    private val badges: HuntBadgeSink = HuntBadgeSink.None,
    /** True during quiet hours: the page must play no sound. */
    private val quiet: () -> Boolean = { false },
) {
    private var session: HuntSession? = null
    private var recorded = false
    private val reads = RateLimiter(60, 10_000, clock)
    private val writes = RateLimiter(20, 10_000, clock)
    private val ticks = RateLimiter(10, 10_000, clock)

    // ---- host ---------------------------------------------------------------------------

    /** Open a lobby with [requested]. Returns null on success or a message for the host. */
    @Synchronized
    fun open(requested: HuntSettings): String? {
        val s = requested.normalised()
        val card = HuntCatalog.byId(s.cardId) ?: return "That card is not available."
        val pick = HuntSelector.select(card, s.band, s.itemCount, random).getOrElse { return it.message ?: "Not enough items." }
        val now = clock()
        session?.let { finishIfDone(it) }
        session = HuntSession(s, card, pick.items, pick.gridSize, HuntPhotoPrompts.forDay(now / DAY_MS), now)
        recorded = false
        return null
    }

    @Synchronized
    fun start(): String? {
        val s = session ?: return "Open a hunt first."
        return s.start(clock())
    }

    /** Host: stop now. Finds still waiting for approval do not count. */
    @Synchronized
    fun end() {
        val s = session ?: return
        s.end(clock())
        finishIfDone(s)
    }

    @Synchronized
    fun approve(entityKey: String, itemId: String): String? {
        val s = session ?: return "Open a hunt first."
        val error = s.approve(entityKey, itemId, clock())
        finishIfDone(s)
        return error
    }

    @Synchronized
    fun approveAll(): Int {
        val s = session ?: return 0
        val n = s.approveAll(clock())
        finishIfDone(s)
        return n
    }

    /** Host: turn a find down or take away a counted one. */
    @Synchronized
    fun remove(entityKey: String, itemId: String) {
        session?.remove(entityKey, itemId, clock())
    }

    /** Forget the hunt entirely (back to setup). A hunt that had finished has already been recorded. */
    @Synchronized
    fun close() {
        session?.let { s -> s.sync(clock()); finishIfDone(s) }
        session = null
        recorded = false
    }

    @Synchronized
    fun hostState(): HuntHostState {
        val s = session ?: return HuntHostState.NONE
        val now = clock()
        s.sync(now)
        finishIfDone(s)
        val rows = s.rows(now)
        return HuntHostState(
            phase = s.phase, settings = s.settings, cardTitle = s.card.title, cardEmoji = s.card.emoji, layout = s.layout,
            itemCount = s.items.size, rows = rows, winners = if (s.phase == HuntPhase.DONE) HuntScoring.winners(rows) else emptyList(),
            pending = s.pendingQueue(), players = s.playerLines(), contributions = s.contributions(),
            remainingMs = s.remainingMs(now),
            elapsedMs = when (s.phase) {
                HuntPhase.LOBBY -> 0L
                HuntPhase.RUNNING -> (now - s.startedAt).coerceAtLeast(0L)
                HuntPhase.DONE -> (s.endedAt - s.startedAt).coerceAtLeast(0L)
            },
            stoppedByHost = s.stoppedByHost, timedOut = s.timedOut, allFinished = s.allFinished,
            photoPrompt = s.photoPrompt, photoCount = s.photoCount, maxPoints = s.maxPoints,
        )
    }

    /** Written once, when a hunt with at least one find has finished. Never throws into a guest's request. */
    private fun finishIfDone(s: HuntSession) {
        if (s.phase != HuntPhase.DONE || recorded) return
        recorded = true
        val rows = s.rows()
        val names = s.playerLines().map { it.first }
        runCatching { HuntRecords.tally(s, rows, names)?.let { trip.huntCard(it) } }
        val best = rows.maxOfOrNull { it.found } ?: 0
        if (best > 0) runCatching { badges.finished(best, rows.any { it.done }) }
    }

    // ---- the guest door -----------------------------------------------------------------

    @Synchronized
    fun get(token: String, name: String): FamilyReply {
        if (!reads.allow(token)) return FamilyReply.error(429, "Slow down a little.")
        val s = session
        s?.sync(clock())
        s?.let { finishIfDone(it) }
        return FamilyReply.ok(view(s, token))
    }

    /** POST: `join`, `team` {team}, `tick` {item}, `untick` {item}, `potd`. The reply is always the fresh state. */
    @Synchronized
    fun post(token: String, name: String, body: JsonObject): FamilyReply {
        if (!writes.allow(token)) return FamilyReply.error(429, "Slow down a little.")
        val s = session ?: return FamilyReply.error(409, "No hunt is open yet. Ask your host to start one.")
        val now = clock()
        val action = body.textOrNull("action", 20)
        if (action == "tick" || action == "untick") {
            if (!ticks.allow(token)) return FamilyReply.error(429, "Slow down a little.")
        }
        val joinError = joinIfNeeded(s, token, name, now)
        val error: String? = when {
            joinError != null -> joinError
            action == "join" -> null
            action == "team" -> s.setTeam(token, body.intOrNull("team") ?: -1, now)
            action == "tick" -> s.tick(token, body.textOrNull("item", 40).orEmpty(), now)
            action == "untick" -> s.untick(token, body.textOrNull("item", 40).orEmpty(), now)
            action == "potd" -> s.photoTaken(token, now)
            else -> "Unknown action."
        }
        finishIfDone(s)
        return if (error == null) FamilyReply.ok(view(s, token)) else FamilyReply.error(409, error)
    }

    private fun joinIfNeeded(s: HuntSession, token: String, name: String, now: Long): String? {
        if (s.hasPlayer(token)) return null
        return s.join(token, HuntNames.clean(name, "Camper"), now)
    }

    private fun view(s: HuntSession?, token: String): JsonObject {
        if (s == null) return buildJsonObject { put("ok", true); put("phase", "idle"); put("quiet", quiet()) }
        val now = clock()
        val mine = s.hasPlayer(token)
        val rows = s.rows(now)
        val myRow = if (mine) s.rankOf(token, now) else null
        val settings = s.settings
        val running = s.phase != HuntPhase.LOBBY
        return buildJsonObject {
            put("ok", true)
            put("phase", s.phase.wire)
            put("quiet", quiet())
            put("card", buildJsonObject {
                put("id", s.card.id); put("title", s.card.title); put("emoji", s.card.emoji)
                put("blurb", s.card.blurb); put("where", s.card.where)
                put("layout", s.layout.wire); put("grid", s.gridSize)
            })
            put("mode", when { settings.teams == 0 -> "solo"; settings.teams == 1 -> "together"; else -> "teams" })
            put("teamNames", buildJsonArray { if (settings.teams >= 2) (0 until settings.teams).forEach { add(JsonPrimitive(HuntTeams.NAMES[it])) } })
            put("total", s.items.size)
            put("maxPoints", s.maxPoints)
            put("timerMinutes", settings.timerMinutes)
            put("remainingMs", s.remainingMs(now))
            put("approval", settings.approval)
            put("photos", settings.photos)
            put("photoOfDay", settings.photoOfDay)
            if (settings.photoOfDay) put("photoPrompt", s.photoPrompt) else put("photoPrompt", "")
            put("ended", buildJsonObject {
                put("byHost", s.stoppedByHost); put("timedOut", s.timedOut); put("everyone", s.allFinished)
                put("durationMs", if (s.phase == HuntPhase.DONE) (s.endedAt - s.startedAt).coerceAtLeast(0L) else 0L)
            })
            if (myRow == null) put("me", JsonNull) else put("me", buildJsonObject {
                put("name", s.nameOf(token))
                put("team", s.teamOf(token))
                put("points", myRow.points); put("found", myRow.found); put("pending", myRow.pending)
                put("lines", myRow.lines); put("rank", myRow.rank); put("done", myRow.done)
                put("photoDone", s.photoDoneBy(token))
            })
            // The list is only sent to somebody who has joined, and only its own: another team's ticks are never here.
            put("items", buildJsonArray {
                if (mine && running) s.itemsFor(token).forEach { v ->
                    add(buildJsonObject {
                        put("id", v.item.id); put("text", v.item.text)
                        if (v.item.hint.isNotEmpty()) put("hint", v.item.hint)
                        put("points", if (s.layout == HuntLayout.BINGO) 1 else v.item.points)
                        put("state", v.state); put("by", v.by); put("mine", v.mine)
                    })
                }
            })
            put("board", buildJsonArray {
                rows.forEach { r ->
                    add(buildJsonObject {
                        put("name", r.name); put("team", r.team); put("members", r.members)
                        put("points", r.points); put("found", r.found); put("lines", r.lines)
                        put("done", r.done); put("rank", r.rank)
                        put("you", myRow != null && myRow.key == r.key)
                    })
                }
            })
            put("players", s.playerCount)
            put("photoCount", s.photoCount)
            if (s.phase == HuntPhase.DONE) put("winners", buildJsonArray { HuntScoring.winners(rows).forEach { add(JsonPrimitive(it.name)) } })
        }
    }

    companion object {
        private const val DAY_MS = 86_400_000L
    }
}
