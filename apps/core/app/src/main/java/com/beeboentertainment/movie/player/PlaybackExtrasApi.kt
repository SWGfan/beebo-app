package com.beeboentertainment.movie.player

import com.beeboentertainment.movie.core.UrlUtils
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** What a seek-preview picture request came back as. */
sealed interface FrameResult {
    class Image(val bytes: ByteArray) : FrameResult
    /** HTTP 202: the computer is still making the set. */
    data object Generating : FrameResult
    /** 401/403: the media token in the address ran out. */
    data object Expired : FrameResult
    data object Failed : FrameResult
}

/**
 * The routes next to /api/playback that PlaybackApi does not know: seek previews, and saving
 * choices whose JSON is built by hand. Same shared client and sign-in as PlaybackApi, so it travels
 * the same home / tunnel / relay path as the video. Every call is fail-soft (null / false).
 */
class PlaybackExtrasApi(
    private val http: OkHttpClient,
    private val baseUrl: () -> String?,
    private val token: () -> String?
) {
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    fun baseUrlNow(): String? = baseUrl()

    suspend fun trickplayInfo(kind: String, id: String): TrickplayInfo? = withContext(Dispatchers.IO) {
        runCatching {
            val url = UrlUtils.endpoint(baseUrl(), PlaybackWire.TRICKPLAY_INFO_PATH + UrlUtils.query("kind" to kind, "id" to id))
                ?: return@runCatching null
            val t = token()?.takeIf { it.isNotBlank() } ?: return@runCatching null
            val req = Request.Builder().url(url).header("Accept", "application/json").header("Authorization", "Bearer $t").get().build()
            http.newCall(req).execute().use { r ->
                if (r.code != 200) null else TrickplayInfo.parse(r.body?.string())
            }
        }.getOrNull()
    }

    /** The picture at [url]; no sign-in header, the media token is inside the address. */
    suspend fun frame(url: String): FrameResult = withContext(Dispatchers.IO) {
        runCatching {
            val req = Request.Builder().url(url).get().build()
            http.newCall(req).execute().use { r ->
                when {
                    r.code == 202 -> FrameResult.Generating
                    r.code == 401 || r.code == 403 -> FrameResult.Expired
                    r.code != 200 -> FrameResult.Failed
                    else -> {
                        val len = r.body?.contentLength() ?: -1L
                        if (len > MAX_FRAME_BYTES) FrameResult.Failed
                        else r.body?.bytes()?.takeIf { it.size <= MAX_FRAME_BYTES }?.let { FrameResult.Image(it) } ?: FrameResult.Failed
                    }
                }
            }
        }.getOrDefault(FrameResult.Failed)
    }

    /** POSTs a ready-made JSON body to [path]; true when the computer said 2xx. */
    suspend fun post(path: String, body: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val url = UrlUtils.endpoint(baseUrl(), path) ?: return@runCatching false
            val t = token()?.takeIf { it.isNotBlank() } ?: return@runCatching false
            val req = Request.Builder().url(url)
                .header("Accept", "application/json").header("Authorization", "Bearer $t")
                .post(body.toRequestBody(jsonType)).build()
            http.newCall(req).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    private companion object {
        const val MAX_FRAME_BYTES = 512 * 1024
    }
}
