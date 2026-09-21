package com.beeboentertainment.movie.data

import com.beeboentertainment.movie.core.AdminErrors
import com.beeboentertainment.movie.core.MediaTokenHeader
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.core.WatchedMarks
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

/** Thrown when the server says 401 — the UI catches this and bounces to the login screen. */
class UnauthorizedException(message: String = "unauthorized") : IOException(message)

/**
 * Any other visible failure (unreachable server, bad JSON, 5xx). Message is user-showable.
 *
 * [dnsFailure] is set only when the host name itself could not be looked up. It is worth
 * singling out because it is the one network failure with a one-tap cure - the address is
 * gone, so offer the default one - whereas a timeout or a refused connection usually means
 * the address is fine and something else is wrong. Defaulted, so existing throw sites are
 * untouched.
 */
class ApiException(
    message: String,
    val code: Int = 0,
    val dnsFailure: Boolean = false,
) : IOException(message)

/**
 * A 403 carrying a machine-readable reason — `https_required` or `admin_only` on the admin
 * routes. Deliberately NOT an UnauthorizedException: those two mean "this connection or this
 * account can't do that", not "your session died", and signing the user out over them would be
 * both wrong and baffling.
 */
class ForbiddenException(val error: String, message: String) : IOException(message)

/**
 * Thin OkHttp + kotlinx.serialization client for the Beebo Entertainment JSON API.
 *
 * Deliberately not Retrofit: there are ~9 endpoints and keeping the dependency list lean was
 * part of the brief. Every call is a suspend function on Dispatchers.IO.
 */
class ApiClient(
    private val session: SessionStore,
    private val http: OkHttpClient = defaultHttpClient()
) {

    companion object {
        val JSON = Json {
            ignoreUnknownKeys = true
            isLenient = true
            coerceInputValues = true
            explicitNulls = false
        }

        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        fun defaultHttpClient(): OkHttpClient = com.beeboentertainment.movie.core.CleartextPolicy.install(OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            // Asserted explicitly rather than left to the default: the server 308-redirects
            // plain HTTP to HTTPS on the same port, and a cross-scheme redirect is only followed
            // when followSslRedirects is on. If this ever flipped off, every phone still holding
            // an http:// base URL would break at once.
            .followRedirects(true)
            .followSslRedirects(true)
            // Learns whether the server reads the media token from a header (see
            // MediaTokenHeader), from the server that actually answered.
            .addInterceptor { chain ->
                chain.proceed(chain.request()).also { r ->
                    MediaTokenHeader.noteResponse(r.request.url.toString(), r.header(MediaTokenHeader.CAPABILITY))
                }
            }
            // name.beebo.tv: every request (API, posters, the player, subtitles, downloads) goes
            // over the peer-to-peer tunnel away from home, or to the computer's own address at home.
            // A no-op for any other server address. See rtc/TunnelInterceptor.
            .addInterceptor(com.beeboentertainment.movie.rtc.TunnelInterceptor())
            )
            // Plain http only on the local network: added after TunnelInterceptor, so it checks the
            // address a request really goes to, and on every hop (redirects included). Android's
            // network security config can't name address ranges; see CleartextPolicy.
            .build()
    }

    /** Shared client so downloads and the player reuse the same connection pool. */
    val okHttp: OkHttpClient get() = http

    /* ------------------------------------------------------------------ */

    private fun url(path: String): String =
        UrlUtils.endpoint(session.baseUrl, path)
            ?: throw ApiException("No server address configured")

    private fun newRequest(path: String, auth: Boolean): Request.Builder {
        val b = Request.Builder().url(url(path))
        if (auth) {
            val t = session.token
            if (t.isNullOrBlank()) throw UnauthorizedException("no token")
            b.header("Authorization", "Bearer $t")
        }
        b.header("Accept", "application/json")
        return b
    }

    private suspend inline fun <reified T> execute(request: Request): T = withContext(Dispatchers.IO) {
        val response = try {
            http.newCall(request).execute()
        } catch (e: IOException) {
            throw ApiException(friendlyNetworkError(e), dnsFailure = isUnknownHost(e))
        }
        response.use { r ->
            val body = r.body?.string().orEmpty()
            if (r.code == 401) throw UnauthorizedException()
            if (r.code == 403) {
                // The body names the reason; map it to something the owner can act on.
                val reason = errorCodeIn(body)
                throw ForbiddenException(reason, AdminErrors.message(reason))
            }
            if (!r.isSuccessful) {
                // 400/404 from the admin routes also carry a readable code.
                val reason = errorCodeIn(body)
                if (reason.isNotEmpty()) throw ApiException(AdminErrors.message(reason), r.code)
                throw ApiException("Server returned HTTP ${r.code}", r.code)
            }
            try {
                JSON.decodeFromString<T>(body)
            } catch (e: Exception) {
                throw ApiException("Unexpected response from server (not valid Beebo Entertainment JSON)")
            }
        }
    }

    /** Pull {"error":"..."} out of a body without needing its full shape. */
    fun errorCodeIn(body: String?): String = try {
        if (body.isNullOrBlank()) "" else JSON.decodeFromString(OkResponse.serializer(), body).error.orEmpty()
    } catch (_: Exception) {
        ""
    }

    /**
     * Is this failure a name lookup that came back with nothing?
     *
     * Asked by type rather than by reading the message, because the message wording is
     * Android's and has changed between releases. The cause chain is walked because OkHttp
     * wraps the original when it had more than one route to try, and the hop count is a guard
     * against a self-referencing cause rather than a real depth limit.
     */
    private fun isUnknownHost(e: Throwable?): Boolean {
        var t: Throwable? = e
        var hops = 0
        while (t != null && hops < 8) {
            if (t is UnknownHostException) return true
            if (t.message.orEmpty().contains("Unable to resolve host", true)) return true
            t = t.cause
            hops++
        }
        return false
    }

    private fun friendlyNetworkError(e: IOException): String {
        val m = e.message.orEmpty()
        return when {
            isUnknownHost(e) -> "That server address can't be found - the name doesn't exist any more"
            m.contains("timeout", true) -> "Server did not respond in time"
            m.contains("Failed to connect", true) || m.contains("ECONNREFUSED", true) ->
                "Can't reach the server — is it running, and is the port right?"
            m.contains("CLEARTEXT", true) -> "Plain HTTP was blocked by Android (network config problem)"
            else -> "Network error: ${m.ifBlank { e.javaClass.simpleName }}"
        }
    }

    private fun postBody(obj: String) = obj.toRequestBody(JSON_MEDIA)

    /* ----------------------------- endpoints ----------------------------- */

    /** No auth. Used to validate the URL typed on the first-run screen. */
    suspend fun ping(baseUrlOverride: String? = null): PingResponse = withContext(Dispatchers.IO) {
        val target = UrlUtils.endpoint(baseUrlOverride ?: session.baseUrl, "/api/ping")
            ?: throw ApiException("Enter a server address")
        val req = Request.Builder().url(target).header("Accept", "application/json").build()
        execute<PingResponse>(req)
    }

    suspend fun login(username: String, password: String, baseUrlOverride: String? = null): LoginResponse =
        withContext(Dispatchers.IO) {
            val target = UrlUtils.endpoint(baseUrlOverride ?: session.baseUrl, "/api/login")
                ?: throw ApiException("Enter a server address")
            val json = JSON.encodeToString(LoginRequest.serializer(), LoginRequest(username, password))
            val req = Request.Builder().url(target).post(postBody(json)).build()
            // login is the one place a 401 is an expected answer, not a session expiry
            val response = try {
                http.newCall(req).execute()
            } catch (e: IOException) {
                throw ApiException(friendlyNetworkError(e), dnsFailure = isUnknownHost(e))
            }
            response.use { r ->
                val body = r.body?.string().orEmpty()
                try {
                    JSON.decodeFromString(LoginResponse.serializer(), body)
                } catch (e: Exception) {
                    if (r.code == 401) LoginResponse(ok = false, error = "bad_credentials")
                    else throw ApiException("Unexpected response from server (HTTP ${r.code})", r.code)
                }
            }
        }

    suspend fun me(): MeResponse = execute(newRequest("/api/me", true).get().build())

    /** [actor] is a TMDB person id (not a name) and narrows the list to that person's titles. */
    suspend fun movies(
        genre: Int? = null,
        q: String? = null,
        sort: String? = null,
        actor: Int? = null,
        collection: Int? = null
    ): MoviesResponse {
        val qs = UrlUtils.query(
            "genre" to genre?.takeIf { it != 0 }?.toString(),
            "q" to q?.takeIf { it.isNotBlank() },
            "sort" to sort,
            "actor" to actor?.takeIf { it != 0 }?.toString(),
            "collection" to collection?.takeIf { it != 0 }?.toString()
        )
        return execute(newRequest("/api/movies$qs", true).get().build())
    }

    suspend fun tvShows(genre: Int? = null, q: String? = null, actor: Int? = null): TvShowsResponse {
        val qs = UrlUtils.query(
            "genre" to genre?.takeIf { it != 0 }?.toString(),
            "q" to q?.takeIf { it.isNotBlank() },
            "actor" to actor?.takeIf { it != 0 }?.toString()
        )
        return execute(newRequest("/api/tvshows$qs", true).get().build())
    }

    suspend fun episodes(showKey: String): EpisodesResponse =
        execute(newRequest("/api/tvshows/${UrlUtils.encode(showKey)}/episodes", true).get().build())

    /**
     * Genre buckets for the surf pool. Counts already respect an active year/decade filter,
     * so a genre chip's count IS the genre+year pool size — no third call needed.
     * Pass at most one of [year] / [decade]; SurfFilters guarantees that.
     */
    suspend fun surfGenres(kind: String, year: Int? = null, decade: Int? = null): SurfGenresResponse {
        val qs = UrlUtils.query(
            "kind" to kind,
            "year" to year?.toString(),
            "decade" to decade?.toString()
        )
        return execute(newRequest("/api/surf/genres$qs", true).get().build())
    }

    /** Decade + year buckets for the surf pool. Counts respect an active genre filter. */
    suspend fun surfYears(kind: String, genre: String? = null): SurfYearsResponse {
        val qs = UrlUtils.query(
            "kind" to kind,
            "genre" to genre?.takeIf { it.isNotBlank() }
        )
        return execute(newRequest("/api/surf/years$qs", true).get().build())
    }

    suspend fun surf(
        kind: String,
        genre: String?,
        seed: Long?,
        i: Int,
        year: Int? = null,
        decade: Int? = null
    ): SurfResponse {
        val qs = UrlUtils.query(
            "kind" to kind,
            "genre" to genre?.takeIf { it.isNotBlank() },
            "year" to year?.toString(),
            "decade" to decade?.toString(),
            "seed" to seed?.takeIf { it != 0L }?.toString(),
            "i" to i.toString()
        )
        return execute(newRequest("/api/surf$qs", true).get().build())
    }

    /**
     * What plays after this one. The single source of truth for "next" across website, desktop
     * and app — the client derives nothing. Never throws server-side; both fields null means
     * end of series / collection.
     */
    suspend fun upNext(kind: String, id: String): UpNextResponse {
        val qs = UrlUtils.query("kind" to kind, "id" to id)
        return execute(newRequest("/api/upnext$qs", true).get().build())
    }

    /**
     * Save a marker. Only the field being set is populated — the other is left absent, which the
     * server reads as "leave alone". [durationSeconds] is always supplied so the guards apply.
     */
    suspend fun saveMarkers(
        kind: String,
        id: String,
        introEndSeconds: Double? = null,
        creditsStartSeconds: Double? = null,
        durationSeconds: Double? = null
    ): OkResponse {
        val json = JSON.encodeToString(
            MarkersRequest.serializer(),
            MarkersRequest(kind, id, introEndSeconds, creditsStartSeconds, durationSeconds)
        )
        return execute(newRequest("/api/markers", true).post(postBody(json)).build())
    }

    /** Read the markers that apply to this item, re-validated against [durationSeconds]. */
    suspend fun markers(kind: String, id: String, durationSeconds: Double?): MarkersResponse {
        val qs = UrlUtils.query(
            "kind" to kind,
            "id" to id,
            "duration" to durationSeconds?.takeIf { it > 0 }?.let { it.toLong().toString() }
        )
        return execute(newRequest("/api/markers$qs", true).get().build())
    }

    /**
     * Which show an episode belongs to, and where in it. TV only: kind != tv answers 400.
     * The showKey it returns is exactly what /api/tvshows/<showKey>/episodes takes.
     */
    suspend fun episodeContext(id: String): EpisodeContextResponse {
        val qs = UrlUtils.query("kind" to "tv", "id" to id)
        return execute(newRequest("/api/episode-context$qs", true).get().build())
    }

    /**
     * Main cast for a title, up to 8. For kind=tv the id may be an episode id or a show key.
     * An empty list means nothing is cached — the UI renders nothing at all in that case.
     */
    suspend fun credits(kind: String, id: String): CreditsResponse {
        val qs = UrlUtils.query("kind" to kind, "id" to id)
        return execute(newRequest("/api/credits$qs", true).get().build())
    }

    /**
     * Sidecar .srt/.vtt tracks sitting next to this file, already converted to WebVTT server-side.
     *
     * An empty list is the normal answer, not a failure: the great majority of files have no
     * sidecar. The handler swallows its own errors and always answers {ok:true,tracks:[...]},
     * so the only failures reaching here are transport ones - and the player treats those as
     * "no subtitles on offer" rather than surfacing them, because playback must not depend on it.
     */
    suspend fun subtitles(kind: String, id: String): SubtitlesResponse {
        val qs = UrlUtils.query("kind" to kind, "id" to id)
        return execute(newRequest("/api/subtitles$qs", true).get().build())
    }

    /** Partially-watched titles for the signed-in user, newest first. */
    suspend fun continueWatching(): ContinueResponse =
        execute(newRequest("/api/continue", true).get().build())

    /** Everything the user has watched, newest first — finished titles included. */
    suspend fun history(): ContinueResponse =
        execute(newRequest("/api/history", true).get().build())

    /**
     * scope="one" removes every session for that exact fileName; "show" removes every session
     * whose title (or the show half of "Show — S1E2") matches; "all" wipes this user's history.
     * The server always answers ok, even for an unknown scope.
     */
    suspend fun clearHistory(scope: String, fileName: String? = null, title: String? = null): OkResponse {
        val json = JSON.encodeToString(
            HistoryClearRequest.serializer(),
            HistoryClearRequest(scope, fileName, title)
        )
        return execute(newRequest("/api/history/clear", true).post(postBody(json)).build())
    }

    /** How much each of My Library's clear actions would remove. 404 from a server without them. */
    suspend fun libraryClearCounts(): LibraryClearCountsResponse =
        execute(newRequest("/api/library/clear", true).get().build())

    /** what = history | favourites | watchlist | watched; only ever this user's own data. */
    suspend fun clearLibrary(what: String): LibraryClearResponse {
        val json = JSON.encodeToString(LibraryClearRequest.serializer(), LibraryClearRequest(what))
        return execute(newRequest("/api/library/clear", true).post(postBody(json)).build())
    }

    /** Tell the admin a next episode / next collection part is missing. Deduped server-side. */
    suspend fun missingRequest(request: MissingRequest): OkResponse {
        val json = JSON.encodeToString(MissingRequest.serializer(), request)
        return execute(newRequest("/api/missing-request", true).post(postBody(json)).build())
    }

    /* ------------------------ collections (franchises) ------------------------ */

    /** Every franchise the library owns part of. Cache-only on the server; never slow. */
    suspend fun collections(): CollectionsResponse =
        execute(newRequest("/api/collections", true).get().build())

    /**
     * One franchise, in release order, owned and not. A server older than this endpoint
     * answers 404 (ApiException code 404); CollectionScreen falls back to the
     * `movies(collection = id)` filter in that case.
     */
    suspend fun collection(id: Int): CollectionDetailResponse =
        execute(newRequest("/api/collections/$id", true).get().build())

    /* ---------------------------- request a title ---------------------------- */
    /*
     * Business refusals come back with a status and an error code (rate_limited 429,
     * already_in_library 409, owner_only 403, query_too_short 400), which execute() turns
     * into an ApiException / ForbiddenException carrying AdminErrors' wording. no_api_key is
     * a 200 with ok=false and is read from the response.
     */

    /** TMDB search through the server. [kind] is "movie", "tv" or null for both. */
    suspend fun titleSearch(q: String, kind: String? = null): TitleSearchResponse {
        val qs = UrlUtils.query("q" to q.trim(), "kind" to kind?.takeIf { it == "movie" || it == "tv" })
        return execute(newRequest("/api/title-search$qs", true).get().build())
    }

    /** Your requests with their status; the owner gets everyone's, with canDismiss=true. */
    suspend fun titleRequests(): TitleRequestsResponse =
        execute(newRequest("/api/title-requests", true).get().build())

    /** Files (or joins) a request. Deduped server-side on the TMDB id. */
    suspend fun requestTitle(request: TitleRequestCreate): TitleRequestResult {
        val json = JSON.encodeToString(TitleRequestCreate.serializer(), request)
        return execute(newRequest("/api/title-requests", true).post(postBody(json)).build())
    }

    /** Owner only; anyone else gets a ForbiddenException("owner_only"). */
    suspend fun dismissTitleRequest(id: String): TitleRequestResult {
        val json = JSON.encodeToString(TitleRequestIdBody.serializer(), TitleRequestIdBody(id))
        return execute(newRequest("/api/title-requests/dismiss", true).post(postBody(json)).build())
    }

    /* ------------------------- actor page extras ------------------------- */

    /**
     * "Not in your library": [personId]'s films and shows the library lacks, ranked like the
     * desktop's By Actor gap list. No TMDB key / offline comes back ok with no items. A server
     * older than this endpoint answers 404 (ApiException code 404).
     */
    suspend fun actorMissing(personId: Int): ActorMissingResponse =
        execute(newRequest("/api/actor/$personId/missing", true).get().build())

    /** The YouTube key of a title's trailer, or a null key when there isn't one. */
    suspend fun trailer(kind: String, tmdbId: Int): TrailerResponse {
        val qs = UrlUtils.query("kind" to (if (kind == "tv") "tv" else "movie"), "tmdbId" to tmdbId.toString())
        return execute(newRequest("/api/trailer$qs", true).get().build())
    }

    /** The owner's chosen look-it-up site for films and for shows (Google when none is set). */
    suspend fun searchSites(): SearchSitesResponse =
        execute(newRequest("/api/search-sites", true).get().build())

    /* ------------------ personal library + home discovery ------------------ */
    /*
     * All seven of these routes sit BELOW the server's bearer-token gate, so every one of them
     * answers 401 without a session. The UI hides the controls entirely when signed out rather
     * than calling and swallowing the failure.
     */

    /** The signed-in user's "watch later" list. The server returns it newest-first. */
    suspend fun watchlist(): WatchlistResponse =
        execute(newRequest("/api/watchlist", true).get().build())

    /**
     * Add a title, or move one already there back to the top: the server de-duplicates on
     * kind + id + showKey before prepending, so posting the same title twice never doubles it.
     * It answers {ok, entry}; only `ok` is read here.
     */
    suspend fun addToWatchlist(entry: WatchlistAddRequest): OkResponse {
        val json = JSON.encodeToString(WatchlistAddRequest.serializer(), entry)
        return execute(newRequest("/api/watchlist", true).post(postBody(json)).build())
    }

    /**
     * Remove a title. The server's filter matches on id + kind ONLY - showKey plays no part -
     * so the kind sent here has to be the same one it was added with.
     */
    suspend fun removeFromWatchlist(id: String, kind: String): OkResponse {
        val qs = UrlUtils.query("id" to id, "kind" to kind)
        return execute(newRequest("/api/watchlist$qs", true).delete().build())
    }

    /** The watched + favourite flags for one title. An unknown title is both-false, not an error. */
    suspend fun libraryStatus(kind: String, id: String): LibraryStatusResponse {
        val qs = UrlUtils.query("kind" to kind, "id" to id)
        return execute(newRequest("/api/library-status$qs", true).get().build())
    }

    /**
     * The OLD watched route, kept only as the fallback for a computer running a Beebo from before
     * /api/watched/{scope}. On such a server watched=true deletes the item's history row, and a
     * show key clears nothing from Continue Watching. Never use it for an episode or a season.
     */
    suspend fun setWatched(kind: String, id: String, watched: Boolean): OkResponse {
        val json = JSON.encodeToString(WatchedRequest.serializer(), WatchedRequest(kind, id, watched))
        return execute(newRequest("/api/watched", true).post(postBody(json)).build())
    }

    /**
     * Mark a film, an episode, a season or a whole show watched or unwatched - POST
     * /api/watched/{scope} with a body from [WatchedMarks]. Marking watched takes every covered
     * item out of Continue Watching and clears its resume point on the server; the response's
     * ids say which items those were. Unmarking restores nothing.
     */
    suspend fun markWatched(scope: WatchedMarks.Scope, body: String): WatchedMarkResponse =
        execute(newRequest("/api/watched/${scope.path}", true).post(postBody(body)).build())

    suspend fun markMovieWatched(id: String, watched: Boolean): WatchedMarkResponse =
        markWatched(WatchedMarks.Scope.MOVIE, WatchedMarks.itemBody(id, watched))

    suspend fun markEpisodeWatched(id: String, watched: Boolean): WatchedMarkResponse =
        markWatched(WatchedMarks.Scope.EPISODE, WatchedMarks.itemBody(id, watched))

    /** [season] null is the Unsorted bucket. */
    suspend fun markSeasonWatched(showKey: String, season: Int?, watched: Boolean): WatchedMarkResponse =
        markWatched(WatchedMarks.Scope.SEASON, WatchedMarks.seasonBody(showKey, season, watched))

    suspend fun markShowWatched(showKey: String, watched: Boolean): WatchedMarkResponse =
        markWatched(WatchedMarks.Scope.SHOW, WatchedMarks.showBody(showKey, watched))

    /** Set or clear the favourite flag. Nothing else happens; Continue Watching is not touched. */
    suspend fun setFavorite(kind: String, id: String, favorite: Boolean): OkResponse {
        val json = JSON.encodeToString(FavoriteRequest.serializer(), FavoriteRequest(kind, id, favorite))
        return execute(newRequest("/api/favorite", true).post(postBody(json)).build())
    }

    /**
     * Favourites, newest first, in the SAME row shape as /api/continue - the server runs them
     * through its Continue-row decorator, which is why this reuses [ContinueResponse] rather
     * than inventing a twin of it. currentTime/duration/percent are always 0 here. The `stream`
     * it builds is only playable for a movie or episode id: a favourited SHOW comes back with a
     * stream URL built from the show key, which is not a file, so open the show instead.
     */
    suspend fun favorites(): ContinueResponse =
        execute(newRequest("/api/favorites", true).get().build())

    /**
     * Up to 24 newest titles across movies and shows, by recorded add time falling back to file
     * mtime. The handler swallows its own errors and answers an empty list, so this never fails
     * for a reason the user could act on.
     */
    suspend fun recentlyAdded(): ShelfResponse =
        execute(newRequest("/api/recently-added", true).get().build())

    /**
     * Up to 24 not-yet-watched titles sharing this viewer's three most-watched genres, with a
     * ready-made `reason` line. A server with no watch history has no seed genres and answers
     * {ok:true, reason:"", items:[]} - normal first run, not an error, and the shelf must simply
     * not appear.
     */
    suspend fun recommended(): ShelfResponse =
        execute(newRequest("/api/recommended", true).get().build())

    /* ============================== admin API ============================== */
    /*
     * Every /api/admin route requires, in this order: TLS, a bearer token, and isAdmin.
     * A failure of the first two arrives as a ForbiddenException carrying https_required or
     * admin_only; business refusals come back as 200 {ok:false,error} and are read from the
     * response object by the caller.
     */

    suspend fun adminSummary(): AdminSummaryResponse =
        execute(newRequest("/api/admin/summary", true).get().build())

    suspend fun adminUsers(): AdminUsersResponse =
        execute(newRequest("/api/admin/users", true).get().build())

    private fun userIdBody(userId: String) =
        postBody(JSON.encodeToString(AdminUserIdRequest.serializer(), AdminUserIdRequest(userId)))

    suspend fun adminApproveUser(userId: String): AdminUserActionResponse =
        execute(newRequest("/api/admin/users/approve", true).post(userIdBody(userId)).build())

    suspend fun adminReactivateUser(userId: String): AdminUserActionResponse =
        execute(newRequest("/api/admin/users/reactivate", true).post(userIdBody(userId)).build())

    suspend fun adminRevokeUser(userId: String): AdminUserActionResponse =
        execute(newRequest("/api/admin/users/revoke", true).post(userIdBody(userId)).build())

    suspend fun adminSetAdmin(userId: String, isAdmin: Boolean): AdminUserActionResponse {
        val json = JSON.encodeToString(
            AdminSetAdminRequest.serializer(),
            AdminSetAdminRequest(userId, isAdmin)
        )
        return execute(newRequest("/api/admin/users/set-admin", true).post(postBody(json)).build())
    }

    /** Returns the new code ONCE — it is never readable again. */
    suspend fun adminRegenerateCode(userId: String): AdminUserActionResponse =
        execute(newRequest("/api/admin/users/regenerate-code", true).post(userIdBody(userId)).build())

    suspend fun adminRequests(status: String? = null): AdminRequestsResponse {
        val qs = UrlUtils.query("status" to status?.takeIf { it.isNotBlank() })
        return execute(newRequest("/api/admin/requests$qs", true).get().build())
    }

    private fun requestIdBody(requestId: String) = postBody(
        JSON.encodeToString(AdminRequestIdRequest.serializer(), AdminRequestIdRequest(requestId))
    )

    /** Approving creates the account and mints its code — shown once. */
    suspend fun adminApproveRequest(requestId: String): AdminUserActionResponse =
        execute(newRequest("/api/admin/requests/approve", true).post(requestIdBody(requestId)).build())

    suspend fun adminDenyRequest(requestId: String): OkResponse =
        execute(newRequest("/api/admin/requests/deny", true).post(requestIdBody(requestId)).build())

    private fun idBody(id: String) =
        postBody(JSON.encodeToString(AdminIdRequest.serializer(), AdminIdRequest(id)))

    suspend fun adminFlags(): AdminFlagsResponse =
        execute(newRequest("/api/admin/flags", true).get().build())

    suspend fun adminResolveFlag(id: String): AdminFlagsResponse =
        execute(newRequest("/api/admin/flags/resolve", true).post(idBody(id)).build())

    suspend fun adminRemoveFlag(id: String): AdminFlagsResponse =
        execute(newRequest("/api/admin/flags/remove", true).post(idBody(id)).build())

    suspend fun adminMissing(): AdminMissingResponse =
        execute(newRequest("/api/admin/missing", true).get().build())

    suspend fun adminResolveMissing(id: String): AdminMissingResponse =
        execute(newRequest("/api/admin/missing/resolve", true).post(idBody(id)).build())

    suspend fun adminRemoveMissing(id: String): AdminMissingResponse =
        execute(newRequest("/api/admin/missing/remove", true).post(idBody(id)).build())

    suspend fun adminConversions(): AdminConversionsResponse =
        execute(newRequest("/api/admin/conversions", true).get().build())

    suspend fun adminRetryConversion(id: String): AdminConversionsResponse =
        execute(newRequest("/api/admin/conversions/retry", true).post(idBody(id)).build())

    /** Drops the row only — never touches a file on disk. */
    suspend fun adminForgetConversion(id: String): AdminConversionsResponse =
        execute(newRequest("/api/admin/conversions/forget", true).post(idBody(id)).build())

    /** Deletes a real file; the server runs its guardrails and may refuse with 200 {ok:false}. */
    suspend fun adminDeleteOriginal(id: String): AdminConversionsResponse =
        execute(newRequest("/api/admin/conversions/delete-original", true).post(idBody(id)).build())

    suspend fun adminDeleteConverted(id: String): AdminConversionsResponse =
        execute(newRequest("/api/admin/conversions/delete-converted", true).post(idBody(id)).build())

    suspend fun adminMarkers(): AdminMarkersResponse =
        execute(newRequest("/api/admin/markers", true).get().build())

    suspend fun adminClearMarker(scope: String, key: String): AdminMarkersResponse {
        val json = JSON.encodeToString(
            AdminMarkerClearRequest.serializer(),
            AdminMarkerClearRequest(scope, key)
        )
        return execute(newRequest("/api/admin/markers/clear", true).post(postBody(json)).build())
    }

    suspend fun adminHistory(): AdminHistoryResponse =
        execute(newRequest("/api/admin/history", true).get().build())

    suspend fun adminClearHistory(
        scope: String,
        userId: String,
        fileName: String? = null,
        title: String? = null
    ): AdminHistoryClearResponse {
        val json = JSON.encodeToString(
            AdminHistoryClearRequest.serializer(),
            AdminHistoryClearRequest(scope, userId, fileName, title)
        )
        return execute(newRequest("/api/admin/history/clear", true).post(postBody(json)).build())
    }

    suspend fun adminSettings(): AdminSettingsResponse =
        execute(newRequest("/api/admin/settings", true).get().build())

    /** Only folder paths are ever sent; the server allowlists them again on its side. */
    suspend fun adminSaveSettings(update: AdminSettingsUpdateRequest): AdminSettingsResponse {
        val json = JSON.encodeToString(AdminSettingsUpdateRequest.serializer(), update)
        return execute(newRequest("/api/admin/settings", true).post(postBody(json)).build())
    }

    /**
     * The PC's server dashboard. [sections] picks what to fetch (now, bandwidth, health, activity,
     * library) so the live part can be polled every few seconds without the library walk.
     */
    suspend fun adminDashboard(sections: List<String>, days: Int = 7): AdminDashboardResponse {
        val qs = UrlUtils.query("sections" to sections.joinToString(","), "days" to days.toString())
        return execute(newRequest("/api/admin/dashboard$qs", true).get().build())
    }

    /** Owner only; any other admin gets ForbiddenException(owner_only). */
    suspend fun adminStopStream(streamId: String): AdminStopStreamResponse {
        val json = JSON.encodeToString(AdminStopStreamRequest.serializer(), AdminStopStreamRequest(streamId))
        return execute(newRequest("/api/admin/dashboard/stop", true).post(postBody(json)).build())
    }

    /* ============================ end admin API ============================ */

    suspend fun flagQuality(kind: String, id: String): OkResponse {
        val json = JSON.encodeToString(FlagQualityRequest.serializer(), FlagQualityRequest(kind, id))
        return execute(newRequest("/api/flag-quality", true).post(postBody(json)).build())
    }

    suspend fun startWatchSession(kind: String, id: String): WatchSessionResponse {
        val json = JSON.encodeToString(WatchSessionRequest.serializer(), WatchSessionRequest(kind, id))
        return execute(newRequest("/api/watch-session", true).post(postBody(json)).build())
    }

    suspend fun reportProgress(sessionId: String, currentTimeSec: Double, durationSec: Double): OkResponse {
        val json = JSON.encodeToString(
            ProgressRequest.serializer(),
            ProgressRequest(sessionId, currentTimeSec, durationSec)
        )
        return execute(newRequest("/api/progress", true).post(postBody(json)).build())
    }
    /* ============================== playlists ============================== */
    /*
     * /api/playlists/... (the server's playlistApi.js). Everything is per signed-in person: someone
     * else's private playlist answers 404, a shared one they cannot edit answers 403.
     */

    private fun playlistPath(id: String, rest: String = ""): String =
        "/api/playlists/" + java.net.URLEncoder.encode(id, "UTF-8") + rest

    suspend fun playlists(): PlaylistsResponse =
        execute(newRequest("/api/playlists", true).get().build())

    suspend fun playlist(id: String, seed: Long? = null): PlaylistDetailResponse {
        val qs = UrlUtils.query("seed" to seed?.toString())
        return execute(newRequest(playlistPath(id) + qs, true).get().build())
    }

    suspend fun createPlaylist(request: PlaylistCreateRequest): PlaylistDetailResponse {
        val json = JSON.encodeToString(PlaylistCreateRequest.serializer(), request)
        return execute(newRequest("/api/playlists", true).post(postBody(json)).build())
    }

    suspend fun updatePlaylist(id: String, request: PlaylistUpdateRequest): PlaylistDetailResponse {
        val json = JSON.encodeToString(PlaylistUpdateRequest.serializer(), request)
        return execute(newRequest(playlistPath(id, "/update"), true).post(postBody(json)).build())
    }

    suspend fun deletePlaylist(id: String): OkResponse =
        execute(newRequest(playlistPath(id, "/delete"), true).post(postBody("{}")).build())

    suspend fun addToPlaylist(id: String, items: List<PlaylistItemRef>, position: Int? = null): PlaylistDetailResponse {
        val json = JSON.encodeToString(PlaylistAddItemsRequest.serializer(), PlaylistAddItemsRequest(items, position))
        return execute(newRequest(playlistPath(id, "/items"), true).post(postBody(json)).build())
    }

    suspend fun removeFromPlaylist(id: String, entryIds: List<String>): PlaylistDetailResponse {
        val json = JSON.encodeToString(PlaylistRemoveItemsRequest.serializer(), PlaylistRemoveItemsRequest(entryIds))
        return execute(newRequest(playlistPath(id, "/items/remove"), true).post(postBody(json)).build())
    }

    suspend fun movePlaylistItem(id: String, entryId: String, toIndex: Int): PlaylistDetailResponse {
        val json = JSON.encodeToString(PlaylistMoveRequest.serializer(), PlaylistMoveRequest(entryId, toIndex))
        return execute(newRequest(playlistPath(id, "/items/move"), true).post(postBody(json)).build())
    }

    /** The play order. [resume] starts where this person left off (same shuffle order too). */
    suspend fun playPlaylist(id: String, shuffle: Boolean, resume: Boolean, seed: Long? = null): PlaylistPlayResponse {
        val qs = UrlUtils.query(
            "shuffle" to (if (shuffle) "1" else null),
            "resume" to (if (resume) "1" else null),
            "seed" to seed?.toString()
        )
        return execute(newRequest(playlistPath(id, "/play") + qs, true).get().build())
    }

    suspend fun playlistProgress(id: String, entryId: String, index: Int, shuffle: Boolean, seed: Long): OkResponse {
        val json = JSON.encodeToString(PlaylistProgressRequest.serializer(), PlaylistProgressRequest(entryId, index, shuffle, seed))
        return execute(newRequest(playlistPath(id, "/progress"), true).post(postBody(json)).build())
    }

    suspend fun previewPlaylistRules(rules: kotlinx.serialization.json.JsonElement): PlaylistPreviewResponse {
        val json = JSON.encodeToString(PlaylistPreviewRequest.serializer(), PlaylistPreviewRequest(rules))
        return execute(newRequest("/api/playlists/preview", true).post(postBody(json)).build())
    }

    suspend fun playlistFields(): PlaylistFieldsResponse =
        execute(newRequest("/api/playlists/fields", true).get().build())

    /** A show or season as playable episodes, for Play next / Add to queue. */
    suspend fun expandForQueue(items: List<PlaylistItemRef>): PlaylistExpandResponse {
        val json = JSON.encodeToString(PlaylistExpandRequest.serializer(), PlaylistExpandRequest(items))
        return execute(newRequest("/api/playlists/expand", true).post(postBody(json)).build())
    }

    /* ============== parental controls, profiles, library shares ============== */

    /**
     * For the PIN and profile routes a 401 means "wrong PIN", not "signed out", so these read the
     * status themselves instead of going through [execute].
     */
    private suspend fun pinCall(path: String, json: String): Pair<Int, String> = withContext(Dispatchers.IO) {
        val req = newRequest(path, true).post(postBody(json)).build()
        try {
            http.newCall(req).execute().use { r -> r.code to r.body?.string().orEmpty() }
        } catch (e: IOException) {
            throw ApiException(friendlyNetworkError(e), dnsFailure = isUnknownHost(e))
        }
    }

    /** A wrong confirmation password must not be treated as an expired app session. */
    suspend fun viewingPrivacy(): Pair<Int, ViewingPrivacyResponse> {
        val request = newRequest("/api/viewing-privacy", true).get().build()
        return withContext(Dispatchers.IO) {
            try {
                http.newCall(request).execute().use { response ->
                    val body = response.body?.string().orEmpty()
                    response.code to runCatching { JSON.decodeFromString(ViewingPrivacyResponse.serializer(), body) }
                        .getOrDefault(ViewingPrivacyResponse(error = errorCodeIn(body)))
                }
            } catch (e: IOException) {
                throw ApiException(friendlyNetworkError(e), dnsFailure = isUnknownHost(e))
            }
        }
    }

    suspend fun setViewingPrivacy(enabled: Boolean, password: String): Pair<Int, ViewingPrivacyResponse> {
        val (code, body) = pinCall("/api/viewing-privacy", JSON.encodeToString(ViewingPrivacyRequest.serializer(), ViewingPrivacyRequest(enabled, password)))
        return code to runCatching { JSON.decodeFromString(ViewingPrivacyResponse.serializer(), body) }
            .getOrDefault(ViewingPrivacyResponse(error = errorCodeIn(body)))
    }

    suspend fun adminSetAdult(userId: String, adult: Boolean): Pair<Int, AdultProfileResponse> {
        val (code, body) = pinCall("/api/admin/users/adult", JSON.encodeToString(AdultProfileRequest.serializer(), AdultProfileRequest(userId, adult)))
        return code to runCatching { JSON.decodeFromString(AdultProfileResponse.serializer(), body) }
            .getOrDefault(AdultProfileResponse(error = errorCodeIn(body)))
    }

    suspend fun parentalStatus(): ParentalStatusResponse = execute(newRequest("/api/parental/status", true).get().build())

    suspend fun profiles(): ProfilesResponse = execute(newRequest("/api/profiles", true).get().build())

    /** -> (http status, the login shape on success or the error on failure). */
    suspend fun switchProfile(userId: String, pin: String?): Pair<Int, LoginResponse> {
        val (code, body) = pinCall("/api/profiles/switch", JSON.encodeToString(SwitchProfileRequest.serializer(), SwitchProfileRequest(userId, pin)))
        val parsed = runCatching { JSON.decodeFromString(LoginResponse.serializer(), body) }.getOrDefault(LoginResponse(ok = false, error = errorCodeIn(body)))
        return code to parsed
    }

    suspend fun parentalUnlock(pin: String): Pair<Int, PinResponse> {
        val (code, body) = pinCall("/api/parental/unlock", JSON.encodeToString(PinRequest.serializer(), PinRequest(pin = pin)))
        return code to runCatching { JSON.decodeFromString(PinResponse.serializer(), body) }.getOrDefault(PinResponse(error = errorCodeIn(body)))
    }

    suspend fun shareInfo(): ShareInfoResponse = execute(newRequest("/api/share/info", true).get().build())

    suspend fun adminParental(): AdminParentalResponse = execute(newRequest("/api/admin/parental", true).get().build())

    suspend fun adminSetParental(request: AdminParentalSetRequest): AdminParentalSetResponse =
        execute(newRequest("/api/admin/parental/set", true).post(postBody(JSON.encodeToString(AdminParentalSetRequest.serializer(), request))).build())

    suspend fun adminSetPin(pin: String?, currentPin: String?, clear: Boolean = false): Pair<Int, PinResponse> {
        val (code, body) = pinCall("/api/admin/parental/pin", JSON.encodeToString(PinRequest.serializer(), PinRequest(pin = pin, currentPin = currentPin, clear = if (clear) true else null)))
        return code to runCatching { JSON.decodeFromString(PinResponse.serializer(), body) }.getOrDefault(PinResponse(error = errorCodeIn(body)))
    }

    suspend fun adminShares(): AdminSharesResponse = execute(newRequest("/api/admin/shares", true).get().build())

    /** A refusal (no consent, a bad email, too many shares) comes back as 400 {ok:false,error}. */
    suspend fun adminCreateShare(request: CreateShareRequest): ShareActionResponse {
        val (code, body) = pinCall("/api/admin/shares/create", JSON.encodeToString(CreateShareRequest.serializer(), request))
        if (code == 403) throw ForbiddenException(errorCodeIn(body), AdminErrors.message(errorCodeIn(body)))
        return runCatching { JSON.decodeFromString(ShareActionResponse.serializer(), body) }.getOrDefault(ShareActionResponse(error = errorCodeIn(body)))
    }

    suspend fun adminRevokeShare(id: String): ShareActionResponse =
        execute(newRequest("/api/admin/shares/revoke", true).post(idBody(id)).build())
}
