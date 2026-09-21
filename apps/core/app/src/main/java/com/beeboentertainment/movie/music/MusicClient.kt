package com.beeboentertainment.movie.music

import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.ApiException
import com.beeboentertainment.movie.data.SessionStore
import com.beeboentertainment.movie.data.UnauthorizedException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException

/**
 * The /api/music endpoints. Its own small client (rather than more methods on ApiClient) so the
 * Music feature stays in its own files; it shares ApiClient's OkHttp client, so away from home
 * every request still goes over the tunnel, and it reads the same session token.
 */
class MusicClient(
    private val session: SessionStore,
    private val http: OkHttpClient
) {
    private suspend fun <T> get(path: String, serializer: KSerializer<T>): T = withContext(Dispatchers.IO) {
        val url = UrlUtils.endpoint(session.baseUrl, path) ?: throw ApiException("No server address configured")
        val token = session.token
        if (token.isNullOrBlank()) throw UnauthorizedException("no token")
        val request = Request.Builder().url(url)
            .header("Authorization", "Bearer $token")
            .header("Accept", "application/json")
            .build()
        val response = try {
            http.newCall(request).execute()
        } catch (e: IOException) {
            throw ApiException("Can't reach your Beebo computer right now.")
        }
        response.use { r ->
            val body = r.body?.string().orEmpty()
            if (r.code == 401) throw UnauthorizedException()
            if (r.code == 404) throw ApiException("That isn't in the music library any more.", 404)
            if (!r.isSuccessful) throw ApiException("Server returned HTTP ${r.code}", r.code)
            try {
                ApiClient.JSON.decodeFromString(serializer, body)
            } catch (e: Exception) {
                throw ApiException("This Beebo computer needs an update to play music.")
            }
        }
    }

    private fun enc(s: String) = UrlUtils.encode(s)

    suspend fun status(): MusicStatus = get("/api/music/status", MusicStatus.serializer())
    suspend fun artists(): MusicArtistsResponse = get("/api/music/artists", MusicArtistsResponse.serializer())
    suspend fun artist(id: String): MusicArtistResponse = get("/api/music/artist/${enc(id)}", MusicArtistResponse.serializer())
    suspend fun albums(artistId: String? = null, sort: String? = null): MusicAlbumsResponse =
        get("/api/music/albums" + UrlUtils.query("artistId" to artistId, "sort" to sort), MusicAlbumsResponse.serializer())
    suspend fun album(id: String): MusicAlbumResponse = get("/api/music/album/${enc(id)}", MusicAlbumResponse.serializer())
    suspend fun tracks(artistId: String? = null): MusicTracksResponse =
        get("/api/music/tracks" + UrlUtils.query("artistId" to artistId), MusicTracksResponse.serializer())
    /** Songs by id, in the order given (unknown ids are skipped) - what a playlist asks for. */
    suspend fun tracksByIds(ids: List<String>): MusicTracksResponse =
        get("/api/music/tracks" + UrlUtils.query("ids" to ids.joinToString(",")), MusicTracksResponse.serializer())
    suspend fun search(q: String): MusicSearchResponse = get("/api/music/search" + UrlUtils.query("q" to q), MusicSearchResponse.serializer())
    suspend fun lyrics(trackId: String): MusicLyricsResponse = get("/api/music/track/${enc(trackId)}/lyrics", MusicLyricsResponse.serializer())

    companion object {
        @Volatile private var shared: MusicClient? = null

        fun get(): MusicClient = shared ?: synchronized(this) {
            shared ?: com.beeboentertainment.movie.BeeboApp.instance.let { MusicClient(it.session, it.api.okHttp) }.also { shared = it }
        }
    }
}
