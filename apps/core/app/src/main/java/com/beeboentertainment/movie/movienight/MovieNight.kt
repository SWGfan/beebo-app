package com.beeboentertainment.movie.movienight

import com.beeboentertainment.movie.server.ServerJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import java.net.URI

/**
 * Movie Night (docs/MOVIE-NIGHT.md): party games for the living-room TV, played from phones, made from the
 * owner's own library. The Beebo computer draws the shared screen as a web page (`/movie-night/tv`); this app
 * asks whether it is available, starts a room as the signed-in person, and opens that page in a web view
 * restricted to the computer the person signed in to. Phones join by scanning the QR code the page shows.
 *
 * The reply is data from the network, so it is checked before anything is opened: the address is always on the
 * server the person already chose, on exactly one path, with a ticket of the shape the computer makes. The
 * ticket rides in the address fragment, so it is never sent to the server or logged.
 */
@Serializable
data class MovieNightStatus(
    val ok: Boolean = false,
    val enabled: Boolean = false,
    val available: Boolean = false,
    val reason: String = "",
    val message: String = ""
)

@Serializable
data class MovieNightRoom(
    val ok: Boolean = false,
    val code: String = "",
    val ticket: String = "",
    val tvPath: String = "",
    val hash: String = ""
)

object MovieNight {
    const val TV_PATH = "/movie-night/tv"

    private val TICKET = Regex("^[A-Za-z0-9_-]{32}$")

    /** The shared-screen page any browser can open (it starts a room by itself): `<server>/tv`. */
    fun browserPage(base: String): String = base.trimEnd('/') + "/tv"

    /**
     * The room reply -> the page to open (`<server>/movie-night/tv#k=<ticket>`), or null for anything that is not exactly what the
     * computer sends.
     */
    fun tvUrl(base: String?, room: MovieNightRoom): String? {
        if (!room.ok || room.tvPath != TV_PATH || !TICKET.matches(room.ticket) || room.hash != "k=" + room.ticket) return null
        val origin = originOf(base) ?: return null
        return origin + TV_PATH + "#k=" + room.ticket
    }

    /**
     * May the web view move to [url]? Only pages of the same server (scheme, host and port): the games and the film's player
     * page, nothing else. Everything else is refused and never opened outside the app.
     */
    fun allowsNavigation(base: String?, url: String?): Boolean {
        if (url == null) return false
        if (url == "about:blank") return true
        val a = parts(base) ?: return false
        val b = parts(url) ?: return false
        return a == b
    }

    /** Plain words for a failure. */
    fun explain(status: Int, code: String, fallback: String?): String = when {
        status == 401 -> "This device is no longer signed in."
        status == 403 -> "Movie Night works on the home Wi-Fi. Connect this device to it and try again."
        status == 404 -> "Movie Night isn't available on this computer. Update Beebo on the computer, or ask the owner to turn it on."
        status == 429 || code == "rate_limited" -> "Too many Movie Nights were started just now. Wait a minute and try again."
        !fallback.isNullOrBlank() -> fallback
        else -> "Could not start Movie Night."
    }

    // ---- small URL helpers (java.net.URI: the same on the JVM tests and on Android)

    private data class Origin(val scheme: String, val host: String, val port: Int)

    private fun parts(text: String?): Origin? {
        if (text.isNullOrBlank() || text.any { it.isISOControl() || it == ' ' || it == '\\' }) return null
        val uri = try { URI(text) } catch (_: Exception) { return null }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = uri.host?.lowercase() ?: return null
        if (uri.userInfo != null) return null
        val port = if (uri.port >= 0) uri.port else if (scheme == "https") 443 else 80
        return Origin(scheme, host, port)
    }

    private fun originOf(base: String?): String? {
        val o = parts(base) ?: return null
        val default = if (o.scheme == "https") 443 else 80
        return o.scheme + "://" + o.host + (if (o.port == default) "" else ":" + o.port)
    }
}

/** The two Movie Night routes, over the shared bearer client. */
class MovieNightClient(private val json: ServerJson) {
    suspend fun status(): MovieNightStatus = json.get("/api/movie-night/status", MovieNightStatus.serializer())

    /** Starts a room as the signed-in person. Open [MovieNight.tvUrl] of the answer in a web view. */
    suspend fun createRoom(): MovieNightRoom =
        json.post("/api/movie-night/tv/create", buildJsonObject { }, MovieNightRoom.serializer())

    companion object {
        fun get() = MovieNightClient(ServerJson.get())
    }
}
