package com.beeboentertainment.movie.watchtogether

import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.server.SafeText

/** The pieces of the Watch together contract that need no network: invites, the event stream format, wording. */
object WtProtocol {

    /** The server's fixed reactions. Anything else is refused by the server, so the app never offers it. */
    val REACTIONS = listOf("👍", "❤️", "😂", "😮", "😢", "👏", "🔥", "🎉")

    /** Playback speeds the server accepts for a room. */
    val RATES = listOf(0.5, 0.75, 1.0, 1.25, 1.5, 2.0)

    const val CHAT_MAX = 300
    const val NAME_MAX = 40

    private val CODE_RE = Regex("^[0-9A-HJKMNP-TV-Z]{26}$")

    /** What a person typed or pasted -> the canonical 26-character code, or null. Crockford look-alikes are fixed (O to 0, I and L to 1). */
    fun normalizeCode(raw: String?): String? {
        if (raw == null || raw.length > 64) return null
        var s = raw.uppercase().filter { !it.isWhitespace() && it != '-' }
        s = s.replace('O', '0').replace('I', '1').replace('L', '1')
        return if (CODE_RE.matches(s)) s else null
    }

    /**
     * An invite as people share it: the link ("https://name.beebo.tv/watch-together/join?code=..."), the
     * player link with "wt=", a link with the code after a "#", or just the code. Returns the code, or null.
     * The rest of a link (its host) is deliberately ignored: the app joins on ITS OWN server, never on
     * the address a link happens to name.
     */
    fun codeFromInvite(text: String?): String? {
        val t = text?.trim().orEmpty()
        if (t.isEmpty() || t.length > 2000) return null
        normalizeCode(t)?.let { return it }
        val afterQuery = t.substringAfter('?', "")
        val afterFragment = t.substringAfter('#', "")
        for (part in listOf(afterQuery.substringBefore('#'), afterFragment)) {
            for (pair in part.split('&')) {
                val k = pair.substringBefore('=', "")
                if (k == "code" || k == "wt") {
                    val v = try { java.net.URLDecoder.decode(pair.substringAfter('='), "UTF-8") } catch (_: Exception) { "" }
                    normalizeCode(v)?.let { return it }
                }
            }
        }
        return null
    }

    /* ------------------------------ event stream ------------------------------ */

    data class SseEvent(val event: String, val data: String, val id: String?)

    /**
     * Reads Server-Sent Events line by line. Feed each line (without its newline); an event is
     * returned when its blank line arrives. Comment lines (": hb" heartbeats) and "retry:" are
     * skipped. Data lines are joined with a newline, per the SSE format.
     */
    class SseParser {
        private var event = "message"
        private val data = StringBuilder()
        private var hasData = false
        private var id: String? = null
        private var lastId: String? = null

        /** The id of the newest event seen, for "Last-Event-ID" when reconnecting. */
        val lastEventId: String? get() = lastId

        fun feed(line: String): SseEvent? {
            if (line.isEmpty()) {
                val out = if (hasData) SseEvent(event, data.toString(), id) else null
                if (id != null) lastId = id
                event = "message"; data.setLength(0); hasData = false; id = null
                return out
            }
            if (line.startsWith(":")) return null
            val name = line.substringBefore(':')
            var value = line.substringAfter(':', "")
            if (value.startsWith(" ")) value = value.substring(1)
            when (name) {
                "event" -> event = value.take(31)
                "data" -> { if (hasData) data.append('\n'); data.append(value.take(64 * 1024)); hasData = true }
                "id" -> if (value.length <= 15 && value.all { it.isDigit() }) id = value
            }
            return null
        }
    }

    sealed class Event {
        data class State(val room: WtRoom) : Event()
        data class Chat(val message: WtChat) : Event()
        data class Reaction(val reaction: WtReaction) : Event()
        data class Media(val change: WtMediaChange) : Event()
        data class Closed(val reason: String) : Event()
        object Kicked : Event()
    }

    /** A server event to something the app understands; anything unknown or malformed is dropped. */
    fun decode(e: SseEvent): Event? = try {
        when (e.event) {
            "state" -> Event.State(ApiClient.JSON.decodeFromString(WtRoom.serializer(), e.data))
            "chat" -> Event.Chat(ApiClient.JSON.decodeFromString(WtChat.serializer(), e.data))
            "reaction" -> Event.Reaction(ApiClient.JSON.decodeFromString(WtReaction.serializer(), e.data))
            "media" -> Event.Media(ApiClient.JSON.decodeFromString(WtMediaChange.serializer(), e.data))
            "closed" -> Event.Closed(SafeText.code(ApiClient.JSON.decodeFromString(WtClosed.serializer(), e.data).reason))
            "kicked" -> Event.Kicked
            else -> null
        }
    } catch (_: Exception) {
        null
    }

    /* ------------------------------ wording ------------------------------ */

    /** Words for the server's refusals (its `error` codes). */
    fun message(code: String, serverMessage: String?): String = when (code) {
        "not_found" -> "That room has ended, or the link is not valid."
        "locked" -> "Too many wrong codes. Try again in a few minutes."
        "unavailable" -> "This account is not allowed to watch that title."
        "room_full" -> "That room is full."
        "too_many_rooms" -> "You already have the most rooms open that you can. Close one first."
        "server_busy" -> "This Beebo is hosting as many rooms as it can right now."
        "not_allowed" -> "Only the host can do that in this room."
        "chat_off" -> "The host turned chat off."
        "empty" -> "Type a message first."
        "too_long" -> "That message is too long."
        "rate_limited" -> "Slow down a little."
        "stale" -> "The room moved on. Try again."
        "not_available_to_guests" -> "Watch together is not available in a library shared with you."
        else -> serverMessage?.let { SafeText.clean(it, 200) }?.ifBlank { null } ?: "That didn't work."
    }

    /** A person's line in the panel: "Sam (host) · buffering". */
    fun participantLine(p: WtParticipant, isYou: Boolean): String {
        val bits = mutableListOf<String>()
        val name = SafeText.clean(p.name, NAME_MAX).ifBlank { "Guest" } + if (isYou) " (you)" else ""
        if (p.role == "host") bits += "host"
        if (!p.connected) bits += "away" else if (p.buffering) bits += "buffering" else if (p.ready) bits += "ready"
        return if (bits.isEmpty()) name else name + " · " + bits.joinToString(", ")
    }

    /** "Waiting for Sam to buffer…" when the room is held for someone, else null. */
    fun holdLine(hold: WtHold?): String? {
        if (hold == null) return null
        val names = hold.waitingFor.map { SafeText.clean(it, NAME_MAX) }.filter { it.isNotBlank() }
        return when (hold.reason) {
            "buffering" -> if (names.isEmpty()) "Waiting for someone to buffer…" else "Waiting for " + names.joinToString(", ") + " to buffer…"
            "seek" -> if (names.isEmpty()) "Waiting for everyone to catch up…" else "Waiting for " + names.joinToString(", ") + " to catch up…"
            else -> if (names.isEmpty()) "Waiting for everyone to be ready…" else "Waiting for " + names.joinToString(", ") + "…"
        }
    }

    /** Can this participant change playback? The host always; everyone else only when the room allows it. */
    fun canControl(room: WtRoom, pid: String?): Boolean = pid != null && (room.hostPid == pid || room.settings.control == "everyone")

    fun isHost(room: WtRoom, pid: String?): Boolean = pid != null && room.hostPid == pid

    /** One chat line, cleaned and capped, or null when there is nothing to send. */
    fun cleanOutgoing(text: String?): String? = SafeText.clean(text, CHAT_MAX).takeIf { it.isNotBlank() }

    /** Chat lines kept on screen. */
    fun addChat(list: List<WtChat>, m: WtChat, keep: Int = 100): List<WtChat> {
        if (m.eventId > 0 && list.any { it.eventId == m.eventId }) return list
        if (m.id > 0 && list.any { it.id == m.id && it.pid == m.pid }) return list
        return (list + m).takeLast(keep)
    }

    /** Whether a title of this kind and id may be sent to the server (the server checks again). */
    fun isSafeMediaId(id: String?): Boolean =
        id != null && id.length in 1..700 && id.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '_' || it == '-' }

    fun isMediaKind(kind: String?): Boolean = kind == "movie" || kind == "tv"

    /** The invite link for a code, built from THIS app's own server address. */
    fun inviteUrl(baseUrl: String?, code: String): String? {
        val base = com.beeboentertainment.movie.core.UrlUtils.normalizeBaseUrl(baseUrl) ?: return null
        val c = normalizeCode(code) ?: return null
        return "$base/watch-together/join?code=$c"
    }
}
