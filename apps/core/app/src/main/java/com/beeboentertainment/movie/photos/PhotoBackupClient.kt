package com.beeboentertainment.movie.photos

import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.SessionStore
import com.beeboentertainment.movie.rtc.TunnelProtocol
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/**
 * The phone side of /api/photos/backup/... (see desktop electron/photoBackup.js). Blocking calls, made
 * from the backup worker's background thread through the app's shared OkHttp client, so at home
 * they go straight to the PC and away from home they go through the peer-to-peer tunnel.
 */
class PhotoBackupClient(private val session: SessionStore, private val http: OkHttpClient) {

    @Serializable
    data class Answer(
        val ok: Boolean = false,
        val status: String? = null,
        val error: String? = null,
        val uploadId: String? = null,
        val offset: Long? = null,
        val path: String? = null,
        val duplicate: Boolean = false,
        val chunkSize: Int? = null,
    )

    /** An HTTP answer: code plus whatever JSON came back (defaults when the body was not JSON). */
    data class Reply(val code: Int, val body: Answer)

    @Serializable
    private data class Begin(val device: String, val name: String, val size: Long, val sha256: String, val takenAt: Long)

    @Serializable
    private data class Finish(val uploadId: String)

    class TooLargeForTunnel : IOException("chunk too large for this connection")

    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val octets = "application/octet-stream".toMediaType()

    private fun url(path: String): String =
        UrlUtils.endpoint(session.baseUrl, path) ?: throw IOException("No home computer address saved.")

    private fun token(): String = session.token?.takeIf { it.isNotBlank() } ?: throw IOException("Not signed in.")

    private fun run(request: Request): Reply = try {
        http.newCall(request).execute().use { r ->
            val text = r.body?.string().orEmpty()
            val body = runCatching { ApiClient.JSON.decodeFromString(Answer.serializer(), text) }.getOrDefault(Answer())
            Reply(r.code, body)
        }
    } catch (e: IOException) {
        if (generateSequence<Throwable>(e) { it.cause }.any { it is TunnelProtocol.BodyTooLargeException }) throw TooLargeForTunnel()
        throw e
    }

    private fun post(path: String, json: String): Reply = run(
        Request.Builder().url(url(path))
            .header("Authorization", "Bearer ${token()}")
            .header("Accept", "application/json")
            .post(json.toRequestBody(jsonType))
            .build()
    )

    fun begin(device: String, name: String, size: Long, sha256: String, takenAt: Long): Reply =
        post("/api/photos/backup/begin", ApiClient.JSON.encodeToString(Begin.serializer(), Begin(device, name, size, sha256, takenAt)))

    fun chunk(uploadId: String, offset: Long, bytes: ByteArray, length: Int, sha256: String): Reply = run(
        Request.Builder()
            .url(url("/api/photos/backup/chunk?uploadId=${UrlUtils.encode(uploadId)}&offset=$offset"))
            .header("Authorization", "Bearer ${token()}")
            .header("Accept", "application/json")
            .header("X-Chunk-Sha256", sha256)
            .post(bytes.toRequestBody(octets, 0, length))
            .build()
    )

    fun finish(uploadId: String): Reply =
        post("/api/photos/backup/finish", ApiClient.JSON.encodeToString(Finish.serializer(), Finish(uploadId)))
}
