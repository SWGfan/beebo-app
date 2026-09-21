package com.beeboentertainment.movie.radio

import com.beeboentertainment.movie.server.SafeText

/** Radio rules without Android, for the unit tests. */
object RadioLogic {

    private val STATION_ID = Regex("^(rb:[0-9a-f-]{36}|c:[a-f0-9]{12})$")
    private val SESSION_ID = Regex("^[a-f0-9]{16}$")

    fun isStationId(s: String?): Boolean = s != null && STATION_ID.matches(s)
    fun isSessionId(s: String?): Boolean = s != null && SESSION_ID.matches(s)

    /** Country, tags and bitrate on one line. */
    fun subtitle(s: Station): String {
        val parts = mutableListOf<String>()
        SafeText.clean(s.country, 40).takeIf { it.isNotBlank() }?.let { parts += it }
        val tags = s.tags.map { SafeText.clean(it, 24) }.filter { it.isNotBlank() }.take(3)
        if (tags.isNotEmpty()) parts += tags.joinToString(", ")
        if (s.bitrate > 0) parts += "${s.bitrate} kbps"
        return parts.joinToString(" · ")
    }

    fun name(s: Station): String = SafeText.clean(s.name, 100).ifBlank { "Unnamed station" }

    /** What is playing: "Artist - Title", or the raw line, or nothing yet. */
    fun nowPlayingLine(session: RadioSession?): String? {
        val np = session?.nowPlaying ?: return null
        val artist = SafeText.clean(np.artist, 100)
        val title = SafeText.clean(np.title, 140)
        return when {
            artist.isNotBlank() && title.isNotBlank() -> "$artist - $title"
            title.isNotBlank() -> title
            else -> SafeText.clean(np.raw, 200).ifBlank { null }
        }
    }

    /** Status wording for a session. */
    fun stateLabel(state: String, error: String = ""): String = when (state) {
        "connecting" -> "Connecting…"
        "live" -> "Live"
        "reconnecting" -> "Reconnecting…"
        "idle" -> "Paused"
        "failed" -> "This station isn't answering" + (SafeText.clean(error, 60).takeIf { it.isNotBlank() }?.let { " ($it)" } ?: "")
        "closed" -> "Stopped"
        else -> ""
    }

    /** How often to ask for what is playing: quick while connecting, relaxed once live. */
    fun pollDelayMs(state: String): Long = when (state) {
        "connecting", "reconnecting" -> 2_000L
        "live" -> 8_000L
        else -> 15_000L
    }

    fun isFavourite(favourites: List<Station>, id: String): Boolean = favourites.any { it.id == id }

    /** The relay address for a session, only if it is this session's stream path on this server. */
    fun streamPath(s: RadioSession): String? =
        if (isSessionId(s.id)) SafeText.serverPathOrNull(s.stream, "/api/radio/session/") else null

    /** A station address typed by the person: http or https, a host, no spaces. The server judges the rest and refuses HLS. */
    fun stationAddressOrNull(input: String?): String? {
        val s = input?.trim().orEmpty()
        if (s.length !in 8..1000 || s.any { it.isWhitespace() || it.code < 32 }) return null
        val lower = s.lowercase()
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) return null
        val authority = s.substringAfter("://").substringBefore('/').substringBefore('?').substringBefore('#')
        if (authority.isEmpty() || authority.contains('@')) return null
        return s
    }

    /** Words for refusals on the radio routes. */
    fun refusal(code: String, serverMessage: String?): String = when (code) {
        "station_not_found" -> "That station isn't in the directory any more."
        "too_many_favorites" -> "You have the most favourites allowed. Remove one first."
        "too_many_custom" -> "You have the most stations of your own allowed."
        "bad_url" -> "That isn't a station address the app can use."
        "not_audio" -> "That address isn't an audio stream."
        "http_403", "http_404", "http_410" -> "That station isn't available right now."
        "too_many_sessions" -> "You already have the most radio streams open. Stop one first."
        else -> serverMessage ?: "That didn't work."
    }

    /** Quick filters on the Browse tab: the server's `tag` search. */
    val TAGS = listOf("news", "jazz", "classical", "rock", "pop", "talk", "electronic", "country")
}
