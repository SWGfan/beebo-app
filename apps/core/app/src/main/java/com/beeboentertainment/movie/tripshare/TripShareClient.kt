package com.beeboentertainment.movie.tripshare

import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.SessionStore
import com.beeboentertainment.movie.photos.PhotoBackupClient
import com.beeboentertainment.movie.photos.PhotoUploader
import com.beeboentertainment.movie.rtc.TunnelProtocol
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/** An HTTP answer with the JSON body decoded (null when it was not the shape asked for). */
class TripReply<T>(val code: Int, val body: T?, val error: String?) {
    val ok: Boolean get() = code in 200..299 && body != null
}

/**
 * The phone side of /api/trip-shares/... on the person's OWN computer (desktop electron/tripShareApi.js).
 * Blocking calls made from a background thread through the app's shared OkHttp client: at home they
 * go straight to the computer, away from home through the peer-to-peer tunnel, exactly like photo
 * backup. Every address is built from the saved server address; there is no other host in this file.
 */
class TripShareClient(private val session: SessionStore, private val http: OkHttpClient) : TripSharePc {

    @Serializable private data class CheckItem(val sha256: String, val size: Long)
    @Serializable private data class CheckBody(val tripId: String, val items: List<CheckItem>)
    @Serializable private data class CheckResult(val sha256: String = "", val have: Boolean = false)
    @Serializable private data class CheckAnswer(val ok: Boolean = false, val results: List<CheckResult> = emptyList())
    @Serializable private data class BeginBody(val tripId: String, val kind: String, val sha256: String, val size: Long, val w: Int, val h: Int)
    @Serializable private data class FinishBody(val uploadId: String)
    @Serializable private data class IdBody(val id: String)
    @Serializable private data class ExtendBody(val id: String, val hours: Int)
    @Serializable private data class TripBody(val tripId: String)
    @Serializable private data class CreateBody(val tripId: String, val name: String, val manifest: ShareManifest, val options: CreateOptions)
    @Serializable private data class CreateOptions(val includeLocation: Boolean, val includeSong: Boolean, val rightsAck: Boolean, val expiresInHours: Int)

    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val octets = "application/octet-stream".toMediaType()

    private fun url(path: String): String =
        UrlUtils.endpoint(session.baseUrl, path) ?: throw IOException("No home computer address saved.")

    private fun token(): String = session.token?.takeIf { it.isNotBlank() } ?: throw IOException("Not signed in.")

    private fun request(path: String): Request.Builder =
        Request.Builder().url(url(path)).header("Authorization", "Bearer ${token()}").header("Accept", "application/json")

    private fun execute(request: Request): Pair<Int, String> = try {
        http.newCall(request).execute().use { it.code to it.body?.string().orEmpty() }
    } catch (e: IOException) {
        if (generateSequence<Throwable>(e) { it.cause }.any { it is TunnelProtocol.BodyTooLargeException }) throw PhotoBackupClient.TooLargeForTunnel()
        throw e
    }

    private fun <T> decode(serializer: KSerializer<T>, code: Int, text: String): TripReply<T> {
        val body = runCatching { ApiClient.JSON.decodeFromString(serializer, text) }.getOrNull()
        val error = runCatching { ApiClient.JSON.decodeFromString(SimpleAnswer.serializer(), text).error }.getOrNull()
        return TripReply(code, body, error)
    }

    private fun <B, T> post(path: String, bodySerializer: KSerializer<B>, body: B, out: KSerializer<T>): TripReply<T> {
        val json = ApiClient.JSON.encodeToString(bodySerializer, body)
        val (code, text) = execute(request(path).post(json.toRequestBody(jsonType)).build())
        return decode(out, code, text)
    }

    /* ------------------------------ settings, links ------------------------------ */

    fun status(): TripReply<ServerStatus> {
        val (code, text) = execute(request("/api/trip-shares/status").get().build())
        return decode(ServerStatus.serializer(), code, text)
    }

    fun createShare(tripId: String, name: String, manifest: ShareManifest, options: ShareOptions): TripReply<CreatedShare> =
        post(
            "/api/trip-shares", CreateBody.serializer(),
            CreateBody(tripId, name, manifest, CreateOptions(options.includeLocation, options.includeSong, options.rightsAck, options.expiry.hours)),
            CreatedShare.serializer(),
        )

    fun list(): TripReply<SharesAnswer> {
        val (code, text) = execute(request("/api/trip-shares").get().build())
        return decode(SharesAnswer.serializer(), code, text)
    }

    fun revoke(id: String): TripReply<SimpleAnswer> = post("/api/trip-shares/revoke", IdBody.serializer(), IdBody(id), SimpleAnswer.serializer())
    fun extend(id: String, hours: Int): TripReply<SimpleAnswer> = post("/api/trip-shares/extend", ExtendBody.serializer(), ExtendBody(id, hours), SimpleAnswer.serializer())
    fun delete(id: String): TripReply<SimpleAnswer> = post("/api/trip-shares/delete", IdBody.serializer(), IdBody(id), SimpleAnswer.serializer())
    fun deleteTrip(tripId: String): TripReply<SimpleAnswer> = post("/api/trip-shares/trip/delete", TripBody.serializer(), TripBody(tripId), SimpleAnswer.serializer())

    /* ------------------------------ sending files ------------------------------ */

    override fun have(tripId: String, files: List<Pair<String, Long>>): Set<String> {
        val reply = post(
            "/api/trip-shares/check", CheckBody.serializer(),
            CheckBody(tripId, files.map { CheckItem(it.first, it.second) }), CheckAnswer.serializer(),
        )
        return if (reply.ok) reply.body!!.results.filter { it.have }.map { it.sha256 }.toSet() else emptySet()
    }

    /** Uploads one file with the calls photo backup's [PhotoUploader] expects. */
    override fun transport(tripId: String, file: PreparedFile): PhotoUploader.Transport = object : PhotoUploader.Transport {
        override fun begin(device: String, name: String, size: Long, sha256: String, takenAt: Long): PhotoBackupClient.Reply =
            answer(post("/api/trip-shares/media/begin", BeginBody.serializer(), BeginBody(tripId, file.kind.wire, sha256, size, file.width, file.height), PhotoBackupClient.Answer.serializer()))

        override fun chunk(uploadId: String, offset: Long, bytes: ByteArray, length: Int, sha256: String): PhotoBackupClient.Reply {
            val req = request("/api/trip-shares/media/chunk?uploadId=${UrlUtils.encode(uploadId)}&offset=$offset")
                .header("X-Chunk-Sha256", sha256)
                .post(bytes.toRequestBody(octets, 0, length))
                .build()
            val (code, text) = execute(req)
            return answer(decode(PhotoBackupClient.Answer.serializer(), code, text))
        }

        override fun finish(uploadId: String): PhotoBackupClient.Reply =
            answer(post("/api/trip-shares/media/finish", FinishBody.serializer(), FinishBody(uploadId), PhotoBackupClient.Answer.serializer()))

        private fun answer(r: TripReply<PhotoBackupClient.Answer>): PhotoBackupClient.Reply =
            PhotoBackupClient.Reply(r.code, r.body ?: PhotoBackupClient.Answer(error = r.error))
    }
}
