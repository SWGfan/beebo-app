package com.beeboentertainment.movie.campsite

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** One song in the synced queue. Durations come from the music library's tags. */
internal data class MusicTrackInfo(
    val id: String,
    val title: String,
    val artist: String,
    val album: String,
    val durationMs: Long,
)

/**
 * Who plays what. [EVERYONE] is the whole mix; [LEFT] / [RIGHT] play only that stereo channel (two
 * phones, one either side of the camp, make a stereo pair); [VOICE] is groundwork for Campfire
 * voice-casting - a phone that will speak a character's lines - and for now plays the same mix as
 * [EVERYONE], because no voice content is distributed yet.
 */
internal enum class MusicRole(val wire: String) {
    EVERYONE("everyone"), LEFT("left"), RIGHT("right"), VOICE("voice");

    companion object {
        fun parse(text: String?): MusicRole? = entries.firstOrNull { it.wire == text }
    }
}

/**
 * The shared music session for Campsite Mode: what is playing, and the one number every phone needs
 * to line up - [epochStartMs], the moment (host clock) at which the current track's position 0
 * happens. Position at host time t is simply t - epochStart, so a guest that joins late, seeks, or
 * drifts always asks the same question and gets the same answer. Same anchor-clock idea as
 * [CampsiteWatch], but the clock here is the host's monotonic clock in fractional milliseconds and
 * changes are pushed instead of polled.
 *
 * Host-authoritative: only the host phone's own UI calls the commands. Nothing a guest sends can
 * change what plays; guests only report their state (see [CampsiteMusicHub]).
 *
 * Track boundaries are computed, not signalled: track i+1 starts at epochStart(i) + duration(i).
 * Guests do the same sum from the queue, so a track change needs no message to arrive on time;
 * the broadcast that follows each advance only keeps everyone's copy exact.
 *
 * Pure and single-threaded by lock, with an injected clock, so it is fully unit tested.
 */
internal class CampsiteMusicEngine(private val clockMs: () -> Double) {

    enum class State(val wire: String) { IDLE("idle"), PREPARING("preparing"), PLAYING("playing"), PAUSED("paused"), ENDED("ended") }

    private val lock = Any()
    private var queue: List<MusicTrackInfo> = emptyList()
    private var state = State.IDLE
    private var index = 0
    private var epochStartMs = 0.0
    private var pausedPositionMs = 0L
    private var prepareDeadlineMs = 0.0
    private var seq = 0
    private var rev = 0
    private val roles = LinkedHashMap<String, MusicRole>()

    // ---- commands (host only) ----------------------------------------------------------------

    /**
     * Replace the queue and start preparing: guests download and decode the first tracks, and
     * [tick] starts playback once they are ready (or [PREPARE_TIMEOUT_MS] passes).
     */
    fun load(tracks: List<MusicTrackInfo>, startIndex: Int = 0) = synchronized(lock) {
        val clean = sanitize(tracks)
        if (clean.isEmpty()) { stopLocked(); return@synchronized }
        queue = clean
        index = startIndex.coerceIn(0, clean.size - 1)
        pausedPositionMs = 0
        state = State.PREPARING
        prepareDeadlineMs = clockMs() + PREPARE_TIMEOUT_MS
        bump(command = true)
    }

    /** Start (or resume) with everybody's clock lined up [leadMs] from now. */
    fun play(leadMs: Long = RESUME_LEAD_MS) = synchronized(lock) {
        if (queue.isEmpty()) return@synchronized
        if (state == State.PLAYING) return@synchronized
        if (state == State.ENDED) { index = 0; pausedPositionMs = 0 }
        startAt(pausedPositionMs, leadMs)
        bump(command = true)
    }

    fun pause() = synchronized(lock) {
        if (state != State.PLAYING && state != State.PREPARING) return@synchronized
        pausedPositionMs = if (state == State.PLAYING) positionLocked(clockMs()).coerceIn(0, currentDuration()) else 0
        state = State.PAUSED
        bump(command = true)
    }

    fun seek(positionMs: Long) = synchronized(lock) {
        if (queue.isEmpty()) return@synchronized
        val target = positionMs.coerceIn(0, currentDuration())
        if (state == State.PLAYING) startAt(target, SEEK_LEAD_MS) else { pausedPositionMs = target; if (state == State.ENDED) state = State.PAUSED }
        bump(command = true)
    }

    fun jump(newIndex: Int) = synchronized(lock) {
        if (queue.isEmpty() || newIndex !in queue.indices) return@synchronized
        jumpLocked(newIndex)
    }

    fun next() = synchronized(lock) {
        if (queue.isEmpty()) return@synchronized
        if (index + 1 < queue.size) { jumpLocked(index + 1) } else { finishLocked() }
    }

    fun previous() = synchronized(lock) {
        if (queue.isEmpty()) return@synchronized
        // Same habit as every music player: past the first few seconds, "back" restarts the song.
        val restart = positionLocked(clockMs()) > 3_000
        jumpLocked(if (restart || index == 0) index else index - 1)
    }

    fun stop() = synchronized(lock) { stopLocked() }

    fun setRole(guestId: String, role: MusicRole) = synchronized(lock) {
        if (roles[guestId] == role) return@synchronized
        if (role == MusicRole.EVERYONE) roles.remove(guestId) else roles[guestId] = role
        // Roles are not a transport command: no seq bump, guests just swap channel routing.
        rev++
    }

    fun roleOf(guestId: String): MusicRole = synchronized(lock) { roles[guestId] ?: MusicRole.EVERYONE }

    /** Forget roles of guests that are long gone (called with the ids that still exist). */
    fun retainRoles(known: Set<String>) = synchronized(lock) { roles.keys.retainAll(known) }

    // ---- time --------------------------------------------------------------------------------

    /**
     * Advance the session by the clock: leave PREPARING when [everyoneReady] or the deadline
     * passes, and roll over finished tracks. True if anything changed (so the hub broadcasts).
     */
    fun tick(everyoneReady: Boolean): Boolean = synchronized(lock) {
        val now = clockMs()
        var changed = false
        if (state == State.PREPARING && (everyoneReady || now >= prepareDeadlineMs)) {
            startAt(0, FIRST_START_LEAD_MS)
            bump(command = true)
            changed = true
        }
        if (state == State.PLAYING) {
            while (state == State.PLAYING && now >= epochStartMs + currentDuration()) {
                if (index + 1 < queue.size) {
                    epochStartMs += currentDuration()
                    index++
                } else {
                    finishLocked()
                }
                rev++
                changed = true
            }
        }
        changed
    }

    // ---- reads -------------------------------------------------------------------------------

    val stateNow: State get() = synchronized(lock) { state }
    val revision: Int get() = synchronized(lock) { rev }
    val hasQueue: Boolean get() = synchronized(lock) { queue.isNotEmpty() }

    fun currentTrackId(): String? = synchronized(lock) { queue.getOrNull(index)?.id }

    fun isQueued(trackId: String): Boolean = synchronized(lock) { queue.any { it.id == trackId } }

    /** Ids the host should keep on disk: the current track and the next couple. */
    fun wantedTrackIds(ahead: Int = 2): List<String> = synchronized(lock) {
        if (queue.isEmpty() || state == State.IDLE) emptyList() else queue.drop(index).take(ahead + 1).map { it.id }
    }

    fun positionMs(): Long = synchronized(lock) { positionLocked(clockMs()) }

    /** The host screen's view: title/artist of the current track and where it is. */
    fun summary(): Summary = synchronized(lock) {
        val t = queue.getOrNull(index)
        Summary(state, t, index, queue.size, positionLocked(clockMs()).coerceAtLeast(0), currentDuration(), seq, rev)
    }

    data class Summary(
        val state: State,
        val track: MusicTrackInfo?,
        val index: Int,
        val queueSize: Int,
        val positionMs: Long,
        val durationMs: Long,
        val seq: Int,
        val revision: Int,
    )

    /**
     * What one guest is told. The same shape for a live update and for a late joiner's first
     * message, which is what makes catching up need no special case.
     */
    fun snapshot(guestId: String): JsonObject = synchronized(lock) {
        val now = clockMs()
        buildJsonObject {
            put("t", "state")
            put("v", PROTOCOL_VERSION)
            put("seq", seq)
            put("rev", rev)
            put("state", state.wire)
            put("index", index)
            put("serverNow", now)
            put("epochStart", epochStartMs)
            put("pausedPos", pausedPositionMs)
            put("positionMs", positionLocked(now).coerceAtLeast(0))
            put("role", (roles[guestId] ?: MusicRole.EVERYONE).wire)
            put("queue", queueJson())
        }
    }

    private fun queueJson(): JsonArray = buildJsonArray {
        queue.forEach { t ->
            add(buildJsonObject {
                put("id", t.id)
                put("title", t.title)
                put("artist", t.artist)
                put("album", t.album)
                put("ms", t.durationMs)
            })
        }
    }

    // ---- internals ---------------------------------------------------------------------------

    private fun currentDuration(): Long = queue.getOrNull(index)?.durationMs ?: 0L

    private fun positionLocked(now: Double): Long = when (state) {
        State.PLAYING -> (now - epochStartMs).toLong()
        State.PAUSED, State.PREPARING -> pausedPositionMs
        State.ENDED -> currentDuration()
        State.IDLE -> 0L
    }

    private fun startAt(positionMs: Long, leadMs: Long) {
        state = State.PLAYING
        epochStartMs = clockMs() + leadMs - positionMs
    }

    private fun jumpLocked(newIndex: Int) {
        index = newIndex
        if (state == State.PLAYING || state == State.ENDED) startAt(0, JUMP_LEAD_MS) else pausedPositionMs = 0
        bump(command = true)
    }

    private fun finishLocked() {
        state = State.ENDED
        pausedPositionMs = 0
        bump(command = true)
    }

    private fun stopLocked() {
        if (state == State.IDLE && queue.isEmpty()) return
        queue = emptyList(); state = State.IDLE; index = 0; pausedPositionMs = 0
        bump(command = true)
    }

    private fun bump(command: Boolean) { if (command) seq++; rev++ }

    companion object {
        const val PROTOCOL_VERSION = 1
        const val MAX_QUEUE = 100
        const val MIN_TRACK_MS = 1_000L
        /** A decoded track lives in a guest phone's RAM as raw floats (~11 MB per minute of stereo), so cap it. */
        const val MAX_TRACK_MS = 12 * 60_000L
        const val PREPARE_TIMEOUT_MS = 20_000L
        /** How far ahead of "now" a command's effect is scheduled, so every phone has it before it happens. */
        const val FIRST_START_LEAD_MS = 1_500L
        const val RESUME_LEAD_MS = 600L
        const val SEEK_LEAD_MS = 500L
        const val JUMP_LEAD_MS = 700L
        private const val MAX_TITLE = 80
        private const val MAX_LINE = 60

        /** Drop tracks a guest phone cannot reasonably hold, trim text, cap the queue, keep order. */
        fun sanitize(tracks: List<MusicTrackInfo>): List<MusicTrackInfo> =
            tracks.asSequence()
                .filter { it.id.matches(ID_PATTERN) && it.durationMs in MIN_TRACK_MS..MAX_TRACK_MS }
                .distinctBy { it.id }
                .take(MAX_QUEUE)
                .map { it.copy(title = clean(it.title, MAX_TITLE), artist = clean(it.artist, MAX_LINE), album = clean(it.album, MAX_LINE)) }
                .toList()

        private fun clean(text: String, max: Int) = text.filter { !it.isISOControl() }.trim().take(max)

        /** Ids the music server hands out are hex hashes; anything else never touches a file path. */
        val ID_PATTERN = Regex("^[A-Za-z0-9_-]{1,64}$")
    }
}

/** Formats a fractional-millisecond double for the wire without exponent notation. */
internal fun wireMs(value: Double): String = String.format(java.util.Locale.US, "%.3f", value)
