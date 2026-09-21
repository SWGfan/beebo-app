package com.beeboentertainment.movie.spacesaver

import android.content.Context
import android.net.Uri
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.SessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import okio.source
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Any Space Saver network failure whose message is safe to show. [unauthorized] means a 401. */
class SpaceSaverException(message: String, val unauthorized: Boolean = false) : IOException(message)

/**
 * Networking for Space Saver. Talks to the two server routes:
 *   POST /api/space-saver/check
 *   POST /api/space-saver/upload?path=<enc relPath>&size=<bytes>
 * both authenticated with `Authorization: Bearer {token}` against `session.baseUrl`.
 *
 * The upload body is a STREAMING RequestBody that reads straight from the SAF input stream, so a
 * multi-gigabyte video is never held in memory. Calls run through OkHttp's async API wrapped in a
 * cancellable coroutine, so cancelling the backup aborts the in-flight transfer immediately.
 */
class SpaceSaverClient(
    private val session: SessionStore,
    private val http: OkHttpClient
) {
    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
        private val OCTET_STREAM = "application/octet-stream".toMediaType()
        /** Keep /check payloads sane on very large libraries. */
        private const val CHECK_BATCH = 400
    }

    private fun requireBase(): String =
        session.baseUrl?.takeIf { it.isNotBlank() }
            ?: throw SpaceSaverException("No server address configured")

    private fun requireToken(): String =
        session.token?.takeIf { it.isNotBlank() }
            ?: throw SpaceSaverException("You're not signed in.", unauthorized = true)

    /**
     * Ask the server which of [items] it already holds (same relPath + size). Batched so the
     * request body stays small. Returns the flattened results across all batches.
     */
    suspend fun check(items: List<CheckItem>): List<CheckResult> = withContext(Dispatchers.IO) {
        if (items.isEmpty()) return@withContext emptyList()
        val base = requireBase()
        val token = requireToken()
        val out = ArrayList<CheckResult>(items.size)
        for (batch in items.chunked(CHECK_BATCH)) {
            val url = UrlUtils.endpoint(base, "/api/space-saver/check")
                ?: throw SpaceSaverException("Bad server address")
            val json = ApiClient.JSON.encodeToString(CheckRequest.serializer(), CheckRequest(batch))
            val req = Request.Builder()
                .url(url)
                .header("Authorization", "Bearer $token")
                .header("Accept", "application/json")
                .post(json.toRequestBody(JSON_MEDIA))
                .build()
            executeCall(http.newCall(req)).use { r ->
                val body = r.body?.string().orEmpty()
                if (r.code == 401) throw SpaceSaverException("Your session expired — sign in again.", unauthorized = true)
                if (r.code == 404) throw SpaceSaverException("Couldn't reach Space Saver on your server — is it running the latest version?")
                if (!r.isSuccessful) throw SpaceSaverException("Server error while checking (HTTP ${r.code})")
                val parsed = runCatching {
                    ApiClient.JSON.decodeFromString(CheckResponse.serializer(), body)
                }.getOrNull() ?: throw SpaceSaverException("Unexpected response from server")
                out += parsed.results
            }
        }
        out
    }

    /**
     * Upload one file. The file part streams from `contentResolver.openInputStream(uri)`; nothing
     * is buffered in memory. Returns the parsed response — the caller treats [UploadResponse.onServer]
     * as "safe to delete locally". A parse-able ok:false (e.g. size_mismatch) is returned, not thrown,
     * so the caller can count it as a skip rather than a crash.
     */
    suspend fun upload(context: Context, relPath: String, size: Long, uri: Uri): UploadResponse =
        withContext(Dispatchers.IO) {
            val base = requireBase()
            val token = requireToken()
            val query = "?path=${UrlUtils.encode(relPath)}&size=$size"
            val url = UrlUtils.endpoint(base, "/api/space-saver/upload$query")
                ?: throw SpaceSaverException("Bad server address")

            val fileName = relPath.substringAfterLast('/').ifBlank { "file" }
            val fileBody = object : RequestBody() {
                override fun contentType() = OCTET_STREAM
                override fun contentLength(): Long = size
                override fun writeTo(sink: BufferedSink) {
                    val input = context.contentResolver.openInputStream(uri)
                        ?: throw IOException("Couldn't read the file from storage")
                    input.use { stream -> sink.writeAll(stream.source()) }
                }
            }
            val multipart = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", fileName, fileBody)
                .build()
            val req = Request.Builder()
                .url(url)
                .header("Authorization", "Bearer $token")
                .header("Accept", "application/json")
                .post(multipart)
                .build()

            executeCall(http.newCall(req)).use { r ->
                val body = r.body?.string().orEmpty()
                if (r.code == 401) throw SpaceSaverException("Your session expired — sign in again.", unauthorized = true)
                val parsed = runCatching {
                    ApiClient.JSON.decodeFromString(UploadResponse.serializer(), body)
                }.getOrNull()
                if (parsed != null) return@use parsed
                if (r.code == 404) throw SpaceSaverException("Couldn't reach Space Saver on your server — is it running the latest version?")
                if (!r.isSuccessful) throw SpaceSaverException("Upload failed (HTTP ${r.code})")
                throw SpaceSaverException("Unexpected response from server")
            }
        }

    /**
     * Run an OkHttp call as a suspending function that honours coroutine cancellation: cancelling
     * the coroutine cancels the call, which aborts the streaming upload mid-flight.
     */
    private suspend fun executeCall(call: Call): Response = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { runCatching { call.cancel() } }
        call.enqueue(object : Callback {
            override fun onFailure(c: Call, e: IOException) {
                if (!cont.isCancelled) cont.resumeWithException(SpaceSaverException(friendly(e)))
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
            m.contains("timeout", true) -> "Server did not respond in time"
            m.contains("Failed to connect", true) || m.contains("ECONNREFUSED", true) ->
                "Can't reach your home computer — is it on and reachable?"
            m.contains("Canceled", true) -> "Cancelled"
            else -> "Network error: ${m.ifBlank { e.javaClass.simpleName }}"
        }
    }
}
