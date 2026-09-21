package com.beeboentertainment.movie.spacesaver.gallery

import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.SessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Any gallery network failure whose message is safe to show to a family user.
 * [unauthorized] means a 401 — the caller should route the user to sign in again.
 */
class GalleryException(message: String, val unauthorized: Boolean = false) : IOException(message)

/**
 * Networking for the Space Saver gallery. Talks to three server routes, all authenticated with
 * `Authorization: Bearer {token}` against `session.baseUrl`:
 *
 *   GET /api/space-saver/library?dir=<enc relPath>   -> LibraryResponse (folders + items)
 *   GET /api/space-saver/thumb?rel=<enc relPath>&w=…  -> image/jpeg thumbnail bytes
 *   GET /api/space-saver/file?rel=<enc relPath>       -> original bytes (HTTP Range for photo/video)
 *
 * The thumb/file routes are consumed by Coil and ExoPlayer respectively, so this class only builds
 * their URLs — [thumbUrl] / [fileUrl] — and the auth header is added by those components'
 * interceptors (see AuthedImageLoader and the viewer's OkHttp DataSource). Only [library] performs a
 * request here, wrapped in a cancellable coroutine so it dies with the composable that launched it.
 */
class SpaceSaverGalleryClient(
    private val session: SessionStore = BeeboApp.instance.session,
    private val http: OkHttpClient = BeeboApp.instance.api.okHttp,
    val computer: Boolean = false
) {
    private val route get() = if (computer) "/api/computer-gallery" else "/api/space-saver"

    private fun requireBase(): String =
        session.baseUrl?.takeIf { it.isNotBlank() }
            ?: throw GalleryException("No server address configured")

    private fun requireToken(): String =
        session.token?.takeIf { it.isNotBlank() }
            ?: throw GalleryException("You're not signed in.", unauthorized = true)

    /**
     * Full URL for a thumbnail. Never throws — returns "" when there is no server yet, which makes
     * Coil show its error placeholder instead of crashing the grid.
     */
    fun thumbUrl(rel: String, w: Int = 360): String {
        val base = session.baseUrl?.takeIf { it.isNotBlank() } ?: return ""
        return UrlUtils.endpoint(base, "$route/thumb?rel=${UrlUtils.encode(rel)}&w=$w") ?: ""
    }

    /** Full URL for the original file (photo full-size / video stream). "" when no server. */
    fun fileUrl(rel: String): String {
        val base = session.baseUrl?.takeIf { it.isNotBlank() } ?: return ""
        return UrlUtils.endpoint(base, "$route/file?rel=${UrlUtils.encode(rel)}") ?: ""
    }

    /**
     * List one directory. [dir] is a relative subpath under the user's backup folder ("" = root).
     * Maps 401 -> "session expired" and 404 -> "update the server" per the agreed contract; any
     * other non-2xx or unparseable body becomes a friendly [GalleryException].
     */
    suspend fun library(dir: String, query: String = "", cursor: String = ""): LibraryResponse = withContext(Dispatchers.IO) {
        val base = requireBase()
        val token = requireToken()
        val path = "$route/library?dir=${UrlUtils.encode(dir)}&q=${UrlUtils.encode(query)}&cursor=${UrlUtils.encode(cursor)}"
        val url = UrlUtils.endpoint(base, path)
            ?: throw GalleryException("Bad server address")
        val req = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .header("Accept", "application/json")
            .get()
            .build()
        executeCall(http.newCall(req)).use { r ->
            val body = r.body?.string().orEmpty()
            if (r.code == 401) throw GalleryException("Your session expired — sign in again.", unauthorized = true)
            if (r.code == 403) throw GalleryException("Computer browsing is available to the computer's administrator. Some protected folders cannot be opened.")
            if (r.code == 410) throw GalleryException("This search expired. Tap Search or Refresh to start again.")
            if (r.code == 429) throw GalleryException("The computer is busy. Try again shortly.")
            if (r.code == 404) throw GalleryException("This feature or folder is unavailable. Computer browsing needs Beebo for Windows 0.1.25 or later.")
            if (!r.isSuccessful) throw GalleryException("Server error while loading your library (HTTP ${r.code})")
            runCatching {
                ApiClient.JSON.decodeFromString(LibraryResponse.serializer(), body)
            }.getOrNull() ?: throw GalleryException("Unexpected response from server")
        }
    }

    /** Run an OkHttp call as a suspending, cancellation-honouring function. */
    private suspend fun executeCall(call: Call): Response = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { runCatching { call.cancel() } }
        call.enqueue(object : Callback {
            override fun onFailure(c: Call, e: IOException) {
                if (!cont.isCancelled) cont.resumeWithException(GalleryException(friendly(e)))
            }
            override fun onResponse(c: Call, response: Response) {
                cont.resume(response)
            }
        })
    }

    private fun friendly(e: IOException): String {
        val m = e.message.orEmpty()
        return when {
            m.contains("Unable to resolve host", true) -> "Can't find that server address (DNS failed)"
            m.contains("timeout", true) -> "Your home computer did not respond in time"
            m.contains("Failed to connect", true) || m.contains("ECONNREFUSED", true) ->
                "Can't reach your home computer — is it on and reachable?"
            m.contains("Canceled", true) -> "Cancelled"
            else -> "Network error: ${m.ifBlank { e.javaClass.simpleName }}"
        }
    }
}
