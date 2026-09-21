package com.beeboentertainment.movie.campsite.songbook

import com.beeboentertainment.movie.campsite.family.FamilyReply
import com.beeboentertainment.movie.campsite.family.FamilyText
import com.beeboentertainment.movie.campsite.family.RateLimiter
import com.beeboentertainment.movie.campsite.family.intOrNull
import com.beeboentertainment.movie.campsite.family.textOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Where the songs a family sang go when the host asks: the running trip, or nowhere in a test. */
internal fun interface SongbookTripSink {
    /** One entry per session: [sessionId] is stable for the session so asking twice updates rather than duplicates. */
    fun songs(sessionId: String, titles: List<String>, names: List<String>): Boolean
}

/** Everything the host's own screen needs to draw, read in one locked snapshot. */
internal data class SongbookHostState(
    val song: Song?,
    val step: Int,
    val total: Int,
    val playing: Boolean,
    val auto: Boolean,
    val finished: Boolean,
    val roundMode: Boolean,
    val groups: Int,
    val offsetLines: Int,
    val repeats: Int,
    val lineSeconds: Double,
    val groupLines: List<SongbookEngine.GroupLine>,
    val requests: List<Pair<Song, Int>>,
    val guestNames: List<String>,
    val groupSizes: List<Int>,
    val sung: List<String>,
    val campfire: Boolean,
    val revision: Int,
)

/**
 * The songbook as the campsite server and the host phone's screen see it: one engine, one lock,
 * a guest-facing JSON view, and the small set of things a guest is allowed to do.
 *
 * A guest can join, pick a round group and heart a song. That is all. Playback, tempo, round setup
 * and which song comes next belong to the host phone, which calls straight into [locked] and never
 * goes through the HTTP door. A guest never types free text: the only string a guest can send that
 * reaches anybody else's screen is their join name, and that is cleaned by [FamilyText.name].
 */
internal class SongbookService(
    val library: SongbookLibrary,
    private val clock: () -> Long = System::currentTimeMillis,
    private val trip: SongbookTripSink = SongbookTripSink { _, _, _ -> false },
) {
    val catalog: SongbookCatalog get() = library.catalog
    private val engine = SongbookEngine({ library.catalog }, clock)
    private val reads = RateLimiter(40, 10_000, clock)
    private val writes = RateLimiter(20, 10_000, clock)

    /** Run host-side engine calls under the same lock the web routes use. */
    @Synchronized
    fun <T> locked(block: (SongbookEngine) -> T): T = block(engine)

    @Synchronized
    fun hostState(): SongbookHostState {
        val now = clock()
        val step = engine.currentStep(now)
        return SongbookHostState(
            song = engine.song,
            step = step,
            total = engine.totalSteps,
            playing = engine.playing,
            auto = engine.auto,
            finished = engine.finished(now),
            roundMode = engine.roundMode,
            groups = engine.groups,
            offsetLines = engine.offsetLines,
            repeats = engine.repeats,
            lineSeconds = engine.lineMs / 1000.0,
            groupLines = if (engine.song == null) emptyList()
            else (0 until (if (engine.roundMode) engine.groups else 1)).map { engine.lineFor(it, step) },
            requests = engine.requests(),
            guestNames = engine.guestNames(),
            groupSizes = engine.groupSizes(),
            sung = engine.sungTitles(now),
            campfire = engine.campfire,
            revision = engine.revision,
        )
    }

    // ---- packs (host only) ------------------------------------------------------------------

    /** Host: check and keep a song-pack file the owner chose. */
    @Synchronized
    fun importPack(text: String): ImportOutcome {
        val outcome = library.import(text)
        if (outcome.ok) engine.catalogChanged()
        return outcome
    }

    /** Host: remove an imported pack. */
    @Synchronized
    fun removePack(packId: String): Boolean {
        val removed = library.remove(packId)
        if (removed) engine.catalogChanged()
        return removed
    }

    // ---- the guest door -------------------------------------------------------------------

    /**
     * GET: the current state. [haveSong] is the song revision the page already holds (so the lines are
     * not sent again), [haveList] whether it already has the list of songs.
     */
    @Synchronized
    fun get(token: String, name: String, haveSong: Int, haveList: Boolean): FamilyReply {
        if (!reads.allow(token)) return FamilyReply.error(429, "Slow down a little.")
        if (!engine.join(token, FamilyText.name(name))) return FamilyReply.error(503, "The songbook is full.")
        return FamilyReply.ok(view(token, name, haveSong, haveList))
    }

    /** POST: one of `join`, `group`, `heart`. The reply is always the fresh state. */
    @Synchronized
    fun post(token: String, name: String, body: JsonObject): FamilyReply {
        if (!writes.allow(token)) return FamilyReply.error(429, "Slow down a little.")
        if (!engine.join(token, FamilyText.name(name))) return FamilyReply.error(503, "The songbook is full.")
        val haveSong = body.intOrNull("haveSong") ?: -1
        val haveList = body.intOrNull("haveList") == 1
        var notice: String? = null
        when (body.textOrNull("action", 20)) {
            "join" -> {}
            "group" -> {
                val group = body.intOrNull("group") ?: return FamilyReply.error(400, "Choose a group.")
                if (!engine.setGroup(token, group)) return FamilyReply.error(400, "Choose a group from 1 to ${SongbookEngine.MAX_GROUPS}.")
            }
            "heart" -> {
                val id = body.textOrNull("song", 80) ?: return FamilyReply.error(400, "Choose a song.")
                notice = engine.toggleHeart(token, id)
                if (notice != null && catalog[id] == null) return FamilyReply.error(400, notice)
            }
            else -> return FamilyReply.error(400, "Unknown action.")
        }
        val reply = view(token, name, haveSong, haveList)
        if (notice == null) return FamilyReply.ok(reply)
        return FamilyReply.ok(JsonObject(reply + ("notice" to JsonPrimitive(notice))))
    }

    private fun view(token: String, name: String, haveSong: Int, haveList: Boolean): JsonObject {
        val now = clock()
        val song = engine.song
        return buildJsonObject {
            put("ok", true)
            put("rev", engine.revision)
            put("campfire", engine.campfire)
            put("name", FamilyText.name(name))
            put("step", engine.currentStep(now))
            put("msInto", engine.msIntoStep(now))
            put("playing", engine.playing)
            put("auto", engine.auto)
            put("finished", engine.finished(now))
            put("group", engine.groupOf(token))
            put("groupSizes", buildJsonArray { engine.groupSizes().forEach { add(JsonPrimitive(it)) } })
            if (song == null) put("song", JsonNull) else put("song", buildJsonObject {
                put("id", song.id)
                put("title", song.title)
                put("songRev", engine.songRevision)
                put("round", engine.roundMode)
                put("roundAvailable", song.round != null)
                put("groups", engine.groups)
                put("offset", engine.offsetLines)
                put("repeats", engine.repeats)
                put("lineMs", engine.lineMs)
                put("total", engine.totalSteps)
                if (haveSong != engine.songRevision) {
                    put("lines", JsonArray(song.lines.map { JsonPrimitive(it) }))
                    put("refrain", JsonArray(song.refrainFlags.map { JsonPrimitive(it) }))
                    put("verseStart", JsonArray(song.gapFlags.map { JsonPrimitive(it) }))
                }
            })
            if (!haveList) put("songs", buildJsonArray {
                catalog.songs.forEach { s -> add(buildJsonObject { put("id", s.id); put("title", s.title); put("kind", s.kind) }) }
            })
            put("hearts", buildJsonObject { engine.requests().forEach { (s, n) -> put(s.id, n) } })
            put("mine", buildJsonArray { engine.requests().forEach { (s, _) -> if (engine.hearted(token, s.id)) add(JsonPrimitive(s.id)) } })
        }
    }

    // ---- host: save to the trip ---------------------------------------------------------------

    /**
     * Offer the songs sung this session to the running trip as ONE entry (titles only; guest names
     * only when the host ticked the box). Returns false when nothing was sung yet or no trip is running.
     */
    @Synchronized
    fun saveToTrip(includeNames: Boolean): Boolean {
        val titles = engine.sungTitles(clock())
        if (titles.isEmpty()) return false
        val names = if (includeNames) engine.guestNames() else emptyList()
        return trip.songs("songs-" + (engine.sessionStartedAt.takeIf { it > 0 } ?: clock()), titles, names)
    }
}
