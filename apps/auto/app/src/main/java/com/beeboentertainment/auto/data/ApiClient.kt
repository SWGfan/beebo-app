package com.beeboentertainment.auto.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Thin, blocking-under-coroutines client for the Beebo Entertainment `/api/…` surface.
 *
 * Only the endpoints the car actually needs are here. Admin is deliberately
 * absent — it is HTTPS-gated server-side and has no place on a head unit.
 */
class ApiClient(context: Context) {

    private val app = context.applicationContext
    private val prefs = Prefs.get(app)

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    val baseUrl: String get() = prefs.baseUrl

    // ---------------------------------------------------------------- plumbing

    private suspend inline fun <reified T> get(
        path: String,
        query: Map<String, String?> = emptyMap(),
        authed: Boolean = true,
        throwOn401: Boolean = true,
    ): T = withContext(Dispatchers.IO) {
        val base = prefs.baseUrl
        require(base.isNotBlank()) { "No server address configured" }
        val url = (base + path).toHttpUrlOrNull()
            ?: throw ApiException(0, "bad_url")
        val b = url.newBuilder()
        query.forEach { (k, v) -> if (!v.isNullOrBlank()) b.addQueryParameter(k, v) }

        val req = Request.Builder().url(b.build()).get().apply {
            if (authed) header("Authorization", "Bearer ${requireToken()}")
        }.build()

        execute(req, throwOn401)
    }

    private suspend inline fun <reified T, reified B> post(
        path: String,
        body: B,
        authed: Boolean = true,
        throwOn401: Boolean = true,
        baseOverride: String? = null,
    ): T = withContext(Dispatchers.IO) {
        val base = baseOverride ?: prefs.baseUrl
        require(base.isNotBlank()) { "No server address configured" }
        val payload = json.encodeToString(body).toRequestBody(jsonMediaType)
        val req = Request.Builder()
            .url(base + path)
            .post(payload)
            .apply { if (authed) header("Authorization", "Bearer ${requireToken()}") }
            .build()

        execute(req, throwOn401)
    }

    private class Raw(val code: Int, val body: String)

    /**
     * Runs the call, upgrading the saved address from http to https once if the
     * server asks for it.
     *
     * Beebo Entertainment serves both protocols on one port, so a live certificate turns
     * every plain request into a 308 to a URL that differs only in scheme.
     * OkHttp cannot follow that: it treats same-host-same-port as a reusable
     * connection and re-sends down the existing cleartext socket, which gets
     * 308'd again until it gives up with "Too many follow-up requests: 21".
     * So Http disables cross-scheme following and the upgrade happens here —
     * once, saved to Prefs, so posters and video streams pick it up too rather
     * than paying a wasted round trip each.
     */
    private fun perform(request: Request): Raw {
        var req = request
        var upgraded = false
        while (true) {
            val resp = Http.client().newCall(req).execute()
            val target = if (upgraded) null else {
                httpsUpgradeTarget(req.url, resp.code, resp.header("Location"))
            }
            if (target == null) {
                resp.use { return Raw(it.code, it.body?.string().orEmpty()) }
            }
            resp.close()
            // Only the saved address is upgraded; a sign-in at another address (login's base)
            // must not overwrite it.
            val saved = prefs.baseUrl.toHttpUrlOrNull()
            if (saved != null && saved.host == req.url.host && saved.port == req.url.port) {
                prefs.baseUrl = "https://${target.host}:${target.port}"
            }
            req = req.newBuilder().url(target).build()
            upgraded = true
        }
    }

    /**
     * [throwOn401] is what lets /api/login tell the user *why* they were turned
     * away. The server answers a bad password with a 401 whose body carries the
     * lockout counters, so a blanket UnauthorizedException on 401 would throw
     * that away and leave every failure looking like an unreachable server.
     */
    private inline fun <reified T> execute(req: Request, throwOn401: Boolean = true): T {
        val raw = perform(req)
        if (raw.code == 401 && throwOn401) throw UnauthorizedException()
        val readable = raw.code in 200..299 || raw.code == 401
        if (!readable) {
            val err = runCatching { json.decodeFromString<OkResponse>(raw.body).error }.getOrNull()
            throw ApiException(raw.code, err)
        }
        return json.decodeFromString(raw.body)
    }

    companion object {
        /**
         * The redirect target when a plain request should be retried over TLS,
         * or null for every other redirect — those are left to OkHttp, which
         * handles same-scheme ones correctly.
         */
        fun httpsUpgradeTarget(requestUrl: HttpUrl, code: Int, location: String?): HttpUrl? {
            if (code !in 300..399) return null
            val loc = location?.takeIf { it.isNotBlank() } ?: return null
            val target = requestUrl.resolve(loc) ?: return null
            if (requestUrl.scheme != "http" || target.scheme != "https") return null
            if (target.host != requestUrl.host || target.port != requestUrl.port) return null
            return target
        }
    }

    private fun requireToken(): String =
        prefs.token ?: throw UnauthorizedException()

    // ------------------------------------------------------------------ public

    /** Reachability probe. Needs no token — use it to validate a typed address. */
    suspend fun ping(): PingResponse = get("/api/ping", authed = false)

    /**
     * Sign in to the home server. [base] signs in at that address instead of the saved one
     * (the one sign-in trying the home computer's own address first, at home).
     */
    suspend fun login(username: String, password: String, base: String? = null): LoginResponse =
        post("/api/login", LoginRequest(username, password), authed = false, throwOn401 = false, baseOverride = base)

    suspend fun me(): MeResponse = get("/api/me")

    /**
     * Unauthenticated on purpose, so the phone can find out it is out of date
     * even when its token has expired.
     */
    suspend fun autoVersion(): AutoVersionResponse =
        get("/api/auto-version", authed = false)

    suspend fun movies(
        genre: Int? = null,
        q: String? = null,
        sort: String? = null,
    ): MoviesResponse = get(
        "/api/movies",
        mapOf("genre" to genre?.toString(), "q" to q, "sort" to sort),
    )

    suspend fun tvShows(genre: Int? = null, q: String? = null): TvShowsResponse =
        get("/api/tvshows", mapOf("genre" to genre?.toString(), "q" to q))

    suspend fun episodes(showKey: String): EpisodesResponse =
        get("/api/tvshows/${encodeSegment(showKey)}/episodes")

    /**
     * Maps a TV episode id back to the show it belongs to. Cheap, and the only
     * way to find an episode's show without decoding an id the server tells
     * clients to treat as opaque.
     */
    suspend fun episodeContext(id: String): EpisodeContextResponse =
        get("/api/episode-context", mapOf("kind" to "tv", "id" to id))

    /* --------------------------------- music ---------------------------------
     * The Music library (/api/music). Songs are asked for with tokens=1, so each `stream`
     * arrives with its own short-lived media token, exactly like the film and episode streams
     * this app already plays.
     */

    suspend fun musicStatus(): MusicStatusResponse = get("/api/music/status")

    suspend fun musicArtists(): MusicArtistsResponse = get("/api/music/artists")

    suspend fun musicArtist(artistId: String): MusicArtistResponse =
        get("/api/music/artist/${encodeSegment(artistId)}")

    suspend fun musicAlbums(artistId: String? = null): MusicAlbumsResponse =
        get("/api/music/albums", mapOf("artistId" to artistId))

    suspend fun musicAlbum(albumId: String): MusicAlbumResponse =
        get("/api/music/album/${encodeSegment(albumId)}", mapOf("tokens" to "1"))

    suspend fun musicTracks(artistId: String? = null): MusicTracksResponse =
        get("/api/music/tracks", mapOf("artistId" to artistId, "tokens" to "1"))

    /** One song, or null when the computer no longer has it. */
    suspend fun musicTrack(trackId: String): MusicTrackItem? = runCatching {
        get<MusicTrackResponse>("/api/music/track/${encodeSegment(trackId)}", mapOf("tokens" to "1")).track
    }.getOrNull()

    suspend fun continueWatching(): HistoryResponse = get("/api/continue")

    suspend fun history(): HistoryResponse = get("/api/history")

    suspend fun surf(
        kind: String = "both",
        seed: Long? = null,
        index: Int = 0,
    ): SurfResponse = get(
        "/api/surf",
        mapOf("kind" to kind, "seed" to seed?.toString(), "i" to index.toString()),
    )

    /** Everyone's own playlists plus the ones the owner shares. */
    suspend fun playlists(): PlaylistsListResponse = get("/api/playlists")

    /**
     * A playlist's play order with fresh stream tokens. [resume] makes startIndex the saved
     * place (and a shuffled session keeps its order).
     */
    suspend fun playPlaylist(id: String, shuffle: Boolean = false, resume: Boolean = false): PlaylistPlayOrderResponse = get(
        "/api/playlists/${encodeSegment(id)}/play",
        mapOf("shuffle" to (if (shuffle) "1" else null), "resume" to (if (resume) "1" else null)),
    )

    suspend fun playlistProgress(id: String, body: PlaylistProgressBody): OkResponse =
        post("/api/playlists/${encodeSegment(id)}/progress", body)

    suspend fun startWatchSession(kind: String, id: String, surf: Boolean = false):
        WatchSessionResponse = post("/api/watch-session", WatchSessionRequest(kind, id, surf))

    suspend fun reportProgress(sessionId: String, currentTime: Double, duration: Double):
        OkResponse = post("/api/progress", ProgressRequest(sessionId, currentTime, duration))

    /**
     * Absolute URL for a server-relative path (`/media/poster/603.jpg`,
     * `/file?id=...&mt=...`). The server never returns absolute URLs — it
     * deliberately nulls TMDB CDN links — so anything non-null and non-empty
     * here is safe to prefix.
     */
    fun absolute(serverRelative: String?): String? {
        if (serverRelative.isNullOrBlank()) return null
        if (serverRelative.startsWith("http://") || serverRelative.startsWith("https://")) {
            return serverRelative
        }
        return prefs.baseUrl + serverRelative
    }

    private fun encodeSegment(s: String): String =
        java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}
