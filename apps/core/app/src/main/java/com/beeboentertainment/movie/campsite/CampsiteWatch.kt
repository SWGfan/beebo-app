package com.beeboentertainment.movie.campsite

import kotlinx.serialization.json.*
import java.security.SecureRandom

/**
 * Host-authoritative "watch together" for Campsite Mode.
 *
 * Deliberately separate from [CampsiteGames]. A watch session shares nothing with a
 * game room except the shape of the solution: one in-memory service on the host
 * phone, guests only ever ask "what should I be doing right now", and every answer
 * is computed here. A guest never sets another viewer's state, and never moves the
 * shared clock unless it is the session host.
 *
 * The shared clock is an anchor pair, not a ticking timer. While playing, the true
 * position at wall-clock t is anchorPosition + (t - anchorWall) * rate. Every
 * snapshot answers with the position as of the moment it was written, plus the
 * server's own clock reading, so a guest can subtract its round trip and land in the
 * right place. A late joiner gets exactly the same answer as everyone else, which is
 * what makes arriving mid-film work without any special case.
 *
 * Two counters do different jobs, on purpose:
 *  - seq   bumps only on a deliberate host command (play, pause, seek, end). A guest
 *          that sees a new seq should hard-seek, because the host meant it.
 *  - revision bumps when the roster or the hosting changes, so the page can re-render
 *          without treating it as a transport command.
 * A routine beacon bumps neither: it only re-anchors the clock, and a guest should
 * correct that drift gently rather than jumping.
 *
 * Nothing here is persisted. If the host's process dies, every session dies with it
 * and guests are told to rejoin. That is the honest behaviour for a campsite.
 */
internal class CampsiteWatch(
    private val titleFor: (String) -> String? = { null },
    private val now: () -> Long = System::currentTimeMillis,
) {
    data class Reply(val status: Int, val body: JsonObject)

    /** A one-line view of a live session, for the host phone's own screen. */
    data class Summary(
        val videoId: String,
        val title: String,
        val state: String,
        val positionMs: Long,
        val viewers: Int,
        val hostName: String,
    )

    private class Viewer(
        val token: String,
        val id: String,
        var name: String,
        var seen: Long,
        var video: String? = null,
        var ready: Boolean = false,
        var position: Long = 0L,
        var reportedAt: Long = 0L,
        val actions: LinkedHashSet<String> = linkedSetOf(),
    )

    private class Session(val video: String, val title: String, val createdAt: Long) {
        var host = ""
        val viewers = mutableListOf<String>()
        var revision = 0
        var seq = 0
        var state = "paused"
        var anchorPosition = 0L
        var anchorWall = 0L
        var rate = 1.0
        var durationMs = 0L
        var updatedAt = 0L
        var touched = 0L
        var note = ""
    }

    private val viewers = linkedMapOf<String, Viewer>()
    private val sessions = linkedMapOf<String, Session>()
    private val secure = SecureRandom()

    private fun id(): String = ByteArray(24).also { secure.nextBytes(it) }
        .joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }

    // ---- the shared clock ----------------------------------------------------

    private fun positionAt(s: Session, t: Long): Long {
        val raw = if (s.state == "playing") {
            s.anchorPosition + ((t - s.anchorWall).coerceAtLeast(0L) * s.rate).toLong()
        } else {
            s.anchorPosition
        }
        return clamp(s, raw)
    }

    private fun clamp(s: Session, value: Long): Long {
        val floored = value.coerceAtLeast(0L)
        return if (s.durationMs > 0L) floored.coerceAtMost(s.durationMs) else floored
    }

    /** A playing session that has run past its end settles at "ended" on its own. */
    private fun advance(s: Session) {
        if (s.state != "playing" || s.durationMs <= 0L) return
        val t = now()
        if (positionAt(s, t) >= s.durationMs) {
            s.state = "ended"
            s.anchorPosition = s.durationMs
            s.anchorWall = t
            s.revision++
            s.seq++
            s.updatedAt = t
        }
    }

    private fun anchor(s: Session, position: Long) {
        val t = now()
        s.anchorPosition = clamp(s, position)
        s.anchorWall = t
        s.updatedAt = t
        s.touched = t
    }

    // ---- public surface ------------------------------------------------------

    /** GET with a null request is a plain snapshot; POST passes the decoded action. */
    @Synchronized fun handle(token: String?, guestName: String?, request: JsonObject? = null): Reply {
        cleanup()
        val viewer = register(token, guestName)
            ?: return error(401, "Join the campsite again to watch together.")
        viewer.seen = now()
        if (request == null) return Reply(200, snapshot(viewer))

        val actionId = request.text("actionId")
        if (actionId.length !in 1..100) return error(400, "Please retry that.")
        if (actionId in viewer.actions) return Reply(200, snapshot(viewer))

        try {
            when (val action = request.text("action")) {
                "open" -> open(viewer, request.text("video"))
                "leave" -> leaveSession(viewer)
                "ready" -> {
                    val s = sessionOf(viewer)
                    if (!viewer.ready) { viewer.ready = true; s.revision++ }
                }
                "beacon" -> beacon(viewer, request)
                "claim" -> claim(viewer)
                else -> {
                    val s = sessionOf(viewer)
                    require(s.host == viewer.id) { "Your host controls this one. Sit back." }
                    when (action) {
                        "play" -> { anchor(s, request.long("positionMs")); s.state = "playing"; s.seq++; s.revision++ }
                        "pause" -> { anchor(s, request.long("positionMs")); s.state = "paused"; s.seq++; s.revision++ }
                        "seek" -> { anchor(s, request.long("positionMs")); s.seq++; s.revision++ }
                        "end" -> { anchor(s, request.long("positionMs")); s.state = "ended"; s.seq++; s.revision++ }
                        else -> throw IllegalArgumentException("Unknown watch action.")
                    }
                }
            }
        } catch (e: IllegalArgumentException) {
            return error(409, e.message ?: "Please refresh this page.")
        }

        viewer.actions.add(actionId)
        if (viewer.actions.size > 128) viewer.actions.remove(viewer.actions.first())
        return Reply(200, snapshot(viewer))
    }

    /** Live sessions, newest anchor first, for the host phone's Campsite screen. */
    @Synchronized fun summaries(): List<Summary> {
        cleanup()
        val t = now()
        return sessions.values.map { s ->
            Summary(
                videoId = s.video,
                title = s.title,
                state = s.state,
                positionMs = positionAt(s, t),
                viewers = s.viewers.size,
                hostName = viewerById(s.host)?.name.orEmpty(),
            )
        }
    }

    // ---- actions -------------------------------------------------------------

    private fun register(token: String?, guestName: String?): Viewer? {
        // Identity comes from the cookies the server itself set at /join. A viewer is
        // only ever created for someone who already has both, so a hand-written cookie
        // buys nothing that being on the hotspot did not already buy.
        if (token.isNullOrBlank() || token.length !in 8..128) return null
        val name = guestName?.filter { !it.isISOControl() }?.trim()?.take(24).orEmpty()
        if (name.isBlank()) return null
        val existing = viewers[token]
        if (existing != null) { existing.name = name; return existing }
        if (viewers.size >= MAX_VIEWERS) return null
        val viewer = Viewer(token = token, id = id(), name = name, seen = now())
        viewers[token] = viewer
        return viewer
    }

    private fun sessionOf(v: Viewer): Session =
        sessions[v.video] ?: throw IllegalArgumentException("Open a video first.")

    private fun viewerById(id: String): Viewer? =
        if (id.isBlank()) null else viewers.values.firstOrNull { it.id == id }

    private fun open(v: Viewer, video: String) {
        val title = titleFor(video) ?: throw IllegalArgumentException("That video isn't shared any more.")
        require(sessions.size < MAX_SESSIONS || sessions.containsKey(video)) {
            "Too many videos are already playing at this campsite."
        }
        if (v.video == video && sessions.containsKey(video)) return
        leaveSession(v)
        val s = sessions.getOrPut(video) { Session(video, title, now()).also { it.anchorWall = now(); it.touched = now() } }
        require(s.viewers.size < MAX_VIEWERS_PER_SESSION) { "This watch party is full." }
        s.viewers.add(v.id)
        if (s.host.isBlank()) { s.host = v.id; s.note = "" }
        v.video = video
        // A newly-opened page has had no user gesture yet, so it cannot make sound.
        v.ready = false
        v.position = positionAt(s, now())
        v.reportedAt = 0L
        s.revision++
        s.touched = now()
    }

    private fun beacon(v: Viewer, request: JsonObject) {
        val s = sessionOf(v)
        val position = request.long("positionMs").coerceAtLeast(0L)
        v.position = position
        v.reportedAt = now()
        if (s.host != v.id) return
        // Only the host's beacon moves the shared clock.
        val duration = request.long("durationMs")
        if (duration > 0L) s.durationMs = duration
        val reported = request.text("state")
        if (reported == "playing" || reported == "paused" || reported == "ended") s.state = reported
        anchor(s, position)
    }

    private fun claim(v: Viewer) {
        val s = sessionOf(v)
        if (s.host == v.id) return
        val host = viewerById(s.host)
        require(host == null || now() - host.seen > GRACE_MS) { "Your host is still here." }
        s.host = v.id
        s.note = "${v.name} is looking after playback now."
        s.revision++
        s.touched = now()
    }

    private fun leaveSession(v: Viewer) {
        val s = sessions[v.video]
        v.video = null
        v.ready = false
        v.position = 0L
        v.reportedAt = 0L
        if (s == null) return
        s.viewers.remove(v.id)
        s.revision++
        if (s.host == v.id) reassign(s)
        if (s.viewers.isEmpty()) sessions.remove(s.video)
    }

    /** Hand hosting to whoever has been here longest and is still around. */
    private fun reassign(s: Session) {
        val next = s.viewers.firstOrNull { id -> viewerById(id)?.let { now() - it.seen <= GRACE_MS } == true }
            ?: s.viewers.firstOrNull()
        s.host = next.orEmpty()
        s.note = viewerById(s.host)?.let { "${it.name} is looking after playback now." }.orEmpty()
        s.revision++
    }

    private fun cleanup() {
        val t = now()
        // The same 90-second grace the games use: a guest whose phone slept, or who
        // walked behind the toilet block, keeps their seat for a minute and a half.
        viewers.values.toList().filter { it.video != null && t - it.seen > GRACE_MS }.forEach { leaveSession(it) }
        viewers.entries.removeAll { t - it.value.seen > VIEWER_FORGET_MS }
        sessions.values.toList().forEach { s ->
            advance(s)
            val host = viewerById(s.host)
            if (host == null || t - host.seen > GRACE_MS || host.id !in s.viewers) reassign(s)
        }
        sessions.entries.removeAll { (_, s) ->
            s.viewers.isEmpty() || (t - maxOf(s.touched, s.createdAt) > SESSION_IDLE_MS)
        }
    }

    // ---- snapshot ------------------------------------------------------------

    private fun snapshot(v: Viewer): JsonObject = buildJsonObject {
        val t = now()
        put("ok", true)
        put("you", v.id)
        put("name", v.name)
        // The guest subtracts its own round trip from this to line the clocks up.
        put("serverTime", t)
        put("nowPlaying", buildJsonArray {
            sessions.values.forEach { s ->
                add(buildJsonObject {
                    put("video", s.video)
                    put("title", s.title)
                    put("state", s.state)
                    put("positionMs", positionAt(s, t))
                    put("viewers", s.viewers.size)
                    put("hostName", viewerById(s.host)?.name.orEmpty())
                })
            }
        })
        val s = sessions[v.video] ?: return@buildJsonObject
        put("session", buildJsonObject {
            put("video", s.video)
            put("title", s.title)
            put("host", s.host)
            put("hostName", viewerById(s.host)?.name.orEmpty())
            put("isHost", s.host == v.id)
            put("revision", s.revision)
            put("seq", s.seq)
            put("state", s.state)
            put("positionMs", positionAt(s, t))
            put("durationMs", s.durationMs)
            put("rate", s.rate)
            put("updatedAt", s.updatedAt)
            put("startedAt", s.createdAt)
            put("note", s.note)
            // The browser will not play with sound until this viewer has tapped
            // something. Until then the page must show its own "tap to join" gate
            // rather than pretending everyone is together.
            put("gate", !v.ready)
            put("ready", v.ready)
            val host = viewerById(s.host)
            put("canClaim", s.host != v.id && (host == null || t - host.seen > GRACE_MS))
            put("viewers", buildJsonArray {
                s.viewers.forEach { id ->
                    val other = viewerById(id) ?: return@forEach
                    add(buildJsonObject {
                        put("id", other.id)
                        put("name", other.name)
                        put("host", other.id == s.host)
                        put("online", t - other.seen < ONLINE_MS)
                        put("ready", other.ready)
                        put("positionMs", other.position)
                        put("driftMs", if (other.reportedAt > 0L) other.position - positionAt(s, other.reportedAt) else 0L)
                    })
                }
            })
        })
    }

    private fun error(code: Int, text: String) =
        Reply(code, buildJsonObject { put("ok", false); put("error", text) })

    private fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.content.orEmpty()
    private fun JsonObject.long(key: String) = (this[key] as? JsonPrimitive)?.longOrNull ?: 0L

    companion object {
        private const val GRACE_MS = 90_000L
        private const val ONLINE_MS = 12_000L
        private const val VIEWER_FORGET_MS = 86_400_000L
        private const val SESSION_IDLE_MS = 6 * 60 * 60 * 1000L
        private const val MAX_VIEWERS = 48
        private const val MAX_VIEWERS_PER_SESSION = 32
        private const val MAX_SESSIONS = 8
    }
}
