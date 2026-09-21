package com.beeboentertainment.movie.data

import com.beeboentertainment.movie.core.AudioOption
import com.beeboentertainment.movie.core.HomeTheaterRules
import com.beeboentertainment.movie.core.PlayMethod
import com.beeboentertainment.movie.core.AutoQuality
import com.beeboentertainment.movie.core.QualityChoice
import com.beeboentertainment.movie.core.SubtitleOption
import com.beeboentertainment.movie.core.UrlUtils
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

// ---------------------------- /api/playback routes ----------------------------

@Serializable
data class PlaybackVideo(val codec: String? = null, val width: Int? = null, val height: Int? = null, val hdr: Boolean = false)

@Serializable
data class PlaybackDirect(val android: Boolean = true, val cast: Boolean = true, val castSafe: Boolean = true, val browser: Boolean = false, val reason: String = "")

@Serializable
data class PlaybackOriginal(val label: String = "Original", val height: Int? = null)

@Serializable
data class PlaybackQuality(val id: String = "", val label: String = "", val videoKbps: Int = 0, val height: Int = 0, val upscale: Boolean = false)

@Serializable
data class PlaybackTranscode(val available: Boolean = false, val encoder: String = "", val encoderLabel: String = "", val hardware: Boolean = false, val reason: String = "")

@Serializable
data class PlaybackAudioTrack(
    val ordinal: Int = 0,
    val streamIndex: Int = -1,
    val label: String = "",
    val language: String = "",
    val codec: String? = null,
    val channels: Int? = null,
    val title: String = "",
    val isDefault: Boolean = false,
    val channelLayout: String? = null,
    val profile: String? = null,
    /** What this track is, in plain words, when played as stored (Original quality). */
    val playsAs: PlaybackWords? = null
)

/** A label and a smaller line under it, as the computer words what is playing. */
@Serializable
data class PlaybackWords(val label: String = "", val detail: String = "")

@Serializable
data class PlaybackSoundOptions(
    val surroundAvailable: Boolean = false,
    val delayLimitMs: Int = 500,
    val normalizeNote: String = ""
)

@Serializable
data class PlaybackSubtitleTrack(
    val key: String = "",
    val source: String = "sidecar",
    val kind: String = "text",
    val label: String = "Subtitles",
    val language: String = "",
    val streamIndex: Int? = null,
    val ordinal: Int? = null,
    val codec: String? = null,
    val forced: Boolean = false,
    val hearingImpaired: Boolean = false,
    val url: String = ""
)

@Serializable
data class PlaybackPrefs(
    val quality: String = "auto",
    val audioLanguage: String = "",
    val subtitleLanguage: String = "",
    val subtitlesOn: Boolean = false,
    val audioMode: String = "auto",
    val downmix: String = "standard",
    val night: Boolean = false,
    val normalize: Boolean = false,
    val boostDb: Double = 0.0,
    val audioDelayMs: Int = 0,
    /** Kept raw: an older server omits it and the player's SubtitleStyle parser fills in every default. */
    val subtitleStyle: JsonElement? = null
)

@Serializable
data class OnlineSearchInfo(val configured: Boolean = false)

/**
 * The `homeTheater` block of `GET /api/playback/info`. Its presence is the feature test for `POST /api/playback/negotiate`
 * (docs/HOME-THEATER.md): an older computer has none and the app keeps deciding by itself. [badges] are the file's own labels
 * ("4K", "Dolby Vision", "Atmos").
 */
@Serializable
data class HomeTheaterInfo(val badges: List<String> = emptyList())

@Serializable
data class PlaybackInfo(
    val ok: Boolean = false,
    val kind: String = "movie",
    val id: String = "",
    val durationSec: Double = 0.0,
    val bitrateKbps: Int? = null,
    val video: PlaybackVideo? = null,
    val original: PlaybackOriginal = PlaybackOriginal(),
    val direct: PlaybackDirect = PlaybackDirect(),
    val qualities: List<PlaybackQuality> = emptyList(),
    val transcode: PlaybackTranscode = PlaybackTranscode(),
    val audio: List<PlaybackAudioTrack> = emptyList(),
    val subtitles: List<PlaybackSubtitleTrack> = emptyList(),
    val prefs: PlaybackPrefs = PlaybackPrefs(),
    val onlineSearch: OnlineSearchInfo = OnlineSearchInfo(),
    /**
     * The household's away-from-home plan cap, in pixels of height, or null when there is none
     * (an uncapped/4K-tier plan, or licensing not enforced on this server). Home playback is
     * never capped, whatever this says - callers must combine it with their own "am I away from
     * home right now" check (see [com.beeboentertainment.movie.core.AutoQuality.isAway]).
     * Missing on older servers, which default to null (no cap communicated, not "no cap exists").
     */
    val awayQualityCapHeight: Int? = null,
    /** What the computer can do to the sound; missing on a server that predates the sound options. */
    @SerialName("audioOptions") val soundOptions: PlaybackSoundOptions? = null,
    /**
     * Chapters, other versions of the film and the saved version choice, kept as raw JSON on purpose:
     * they are optional, the shape may drift, and a surprise here must never fail the whole answer.
     * The player's ChapterParser / VersionParser read them defensively.
     */
    val chapters: JsonElement? = null,
    val versions: JsonElement? = null,
    val preferredVersionId: JsonElement? = null,
    /** Null on a computer that predates the home-theatre plan (no negotiate route). */
    val homeTheater: HomeTheaterInfo? = null
) {
    /** The conversions worth offering (none above the file's own picture). */
    val offered: List<QualityChoice>
        get() = qualities.filter { !it.upscale }.mapNotNull { q -> QualityChoice.TRANSCODES.firstOrNull { it.id == q.id } }
            // A small file still gets the lowest one: it saves data even when it can't get sharper.
            .ifEmpty { if (qualities.isEmpty()) QualityChoice.TRANSCODES else listOf(QualityChoice.P480) }

    val audioOptions: List<AudioOption>
        get() = audio.map { AudioOption(it.streamIndex, it.ordinal, it.label, it.language, it.isDefault) }

    val subtitleOptions: List<SubtitleOption>
        get() = subtitles.filter { it.key.isNotBlank() && (it.kind == "image" || it.url.isNotBlank()) }
            .map { SubtitleOption(it.key, it.label, it.language, it.source, it.kind, it.url, it.streamIndex, it.ordinal, it.forced) }
}

@Serializable
data class PlaybackStartRequest(
    val kind: String,
    val id: String,
    val quality: String,
    val audio: Int? = null,
    val burnSubtitle: Int? = null,
    /** auto | stereo | surround | passthrough; left out = stereo AAC exactly as older builds asked. */
    val audioMode: String? = null,
    val downmix: String? = null,
    val night: Boolean? = null,
    val normalize: Boolean? = null,
    val audioDelayMs: Int? = null,
    val audioCaps: AudioCapsRequest? = null
)

/** What this device can play: decoded channels, and the compressed formats it accepts (aac / ac3 / eac3 in HLS). */
@Serializable
data class AudioCapsRequest(val maxChannels: Int, val codecs: List<String>)

@Serializable
data class PlaybackAudioPlan(
    val label: String = "",
    val detail: String = "",
    val kind: String = "",
    val codec: String? = null,
    val channels: Int = 0,
    val mixedDown: Boolean = false,
    val surround: Boolean = false
)

@Serializable
data class PlaybackStartResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val message: String? = null,
    val url: String = "",
    val ticket: String = "",
    val mimeType: String = "application/x-mpegURL",
    val quality: String = "",
    val height: Int = 0,
    val videoKbps: Int = 0,
    val encoderLabel: String = "",
    val audioPlan: PlaybackAudioPlan? = null
)

@Serializable
data class PlaybackStopRequest(val ticket: String)

/** The answer of `POST /api/playback/negotiate`: a plan and the address that plays it. */
@Serializable
data class NegotiateResponse(
    val ok: Boolean = false,
    val method: String = "",
    val url: String = "",
    val ticket: String = "",
    val mimeType: String = "",
    val container: String = "",
    val durationSec: Double = 0.0,
    val error: String? = null,
    val message: String? = null,
    val retryAfterSec: Double? = null
) {
    val playMethod: PlayMethod? get() = PlayMethod.fromWire(method)
    val followable: Boolean get() = ok && HomeTheaterRules.followable(playMethod, url)
}

sealed interface NegotiateResult {
    /** How to play it. Only ever a plan on one of the three routes it may name. */
    data class Plan(val plan: NegotiateResponse) : NegotiateResult

    /** 503 `preparing`: a big film is being read once so it can be streamed without converting it. Ask again. */
    data class Preparing(val retryAfterMs: Long) : NegotiateResult
}

@Serializable
data class PlaybackPrefsUpdate(
    val quality: String? = null,
    val audioLanguage: String? = null,
    val subtitleLanguage: String? = null,
    val subtitlesOn: Boolean? = null,
    val audioMode: String? = null,
    val downmix: String? = null,
    val night: Boolean? = null,
    val normalize: Boolean? = null,
    val audioDelayMs: Int? = null
)

@Serializable
data class PlaybackPrefsResponse(val ok: Boolean = false, val prefs: PlaybackPrefs = PlaybackPrefs())

@Serializable
data class OnlineSubtitle(
    val id: String = "",
    val fileId: Long = 0,
    val fileName: String = "",
    val language: String = "",
    val release: String = "",
    val downloads: Int = 0,
    val hashMatch: Boolean = false,
    val hearingImpaired: Boolean = false,
    val forced: Boolean = false,
    val aiTranslated: Boolean = false,
    val machineTranslated: Boolean = false,
    val title: String = "",
    val year: Int? = null
)

@Serializable
data class OnlineSearchResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val message: String? = null,
    val language: String = "en",
    val results: List<OnlineSubtitle> = emptyList()
)

@Serializable
data class OnlineDownloadRequest(val kind: String, val id: String, val fileId: Long, val lang: String, val hearingImpaired: Boolean, val forced: Boolean)

@Serializable
data class OnlineDownloadResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val message: String? = null,
    val savedAs: String = "",
    val key: String = "",
    val remaining: Int? = null
)

/** Thrown for a start the server refused with a readable reason (busy, conversion off...). */
class PlaybackRefusedException(val error: String, message: String) : IOException(message)

/**
 * The Quality & audio routes. Uses the app's shared OkHttp client, so every call - and the Auto
 * speed test above all - travels the same path the video does: home network, tunnel or relay.
 */
class PlaybackApi(
    private val http: OkHttpClient,
    private val baseUrl: () -> String?,
    private val token: () -> String?
) {
    private val json = ApiClient.JSON
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    private fun request(path: String): Request.Builder {
        val url = UrlUtils.endpoint(baseUrl(), path) ?: throw ApiException("No server address configured")
        val b = Request.Builder().url(url).header("Accept", "application/json")
        val t = token()
        if (t.isNullOrBlank()) throw UnauthorizedException("no token")
        return b.header("Authorization", "Bearer $t")
    }

    private suspend fun call(req: Request): String = withContext(Dispatchers.IO) {
        http.newCall(req).execute().use { r ->
            val body = r.body?.string().orEmpty()
            if (r.code == 401) throw UnauthorizedException()
            if (r.code == 404 && !body.trimStart().startsWith("{")) throw ApiException("This server doesn't offer quality choices yet.", 404)
            if (!r.isSuccessful && r.code != 503 && r.code != 409 && r.code != 400 && r.code != 422) throw ApiException("Server returned HTTP ${r.code}", r.code)
            body
        }
    }

    suspend fun info(kind: String, id: String): PlaybackInfo {
        val qs = UrlUtils.query("kind" to kind, "id" to id)
        return json.decodeFromString(PlaybackInfo.serializer(), call(request("/api/playback/info$qs").get().build()))
    }

    suspend fun start(req: PlaybackStartRequest): PlaybackStartResponse {
        val body = json.encodeToString(req).toRequestBody(jsonType)
        val r = json.decodeFromString(PlaybackStartResponse.serializer(), call(request("/api/playback/start").post(body).build()))
        if (!r.ok || r.url.isBlank()) throw PlaybackRefusedException(r.error ?: "failed", r.message ?: "Couldn't change the quality.")
        return r
    }

    /**
     * Direct play / direct stream / transcode, decided by the computer from this device's declared profile. Call it only when
     * [PlaybackInfo.homeTheater] is present. The profile goes in the JSON body. Throws [PlaybackRefusedException] for an answer
     * that is not a plan the app may follow (the caller then keeps what it had).
     */
    suspend fun negotiate(kind: String, id: String, quality: String, audioStreamIndex: Int?, client: String, profile: JsonObject): NegotiateResult {
        val body = buildJsonObject {
            put("kind", kind)
            put("id", id)
            put("client", client)
            put("quality", quality)
            if (audioStreamIndex != null) put("audio", audioStreamIndex)
            put("deviceProfile", profile)
        }.toString().toRequestBody(jsonType)
        val r = json.decodeFromString(NegotiateResponse.serializer(), call(request("/api/playback/negotiate").post(body).build()))
        if (r.error == "preparing") return NegotiateResult.Preparing(HomeTheaterRules.prepareWaitMs(r.retryAfterSec))
        if (r.followable) return NegotiateResult.Plan(r)
        throw PlaybackRefusedException(r.error ?: "not_followable", r.message ?: "The computer's answer couldn't be used.")
    }

    suspend fun stop(ticket: String) {
        if (ticket.isBlank()) return
        runCatching { call(request("/api/playback/stop").post(json.encodeToString(PlaybackStopRequest(ticket)).toRequestBody(jsonType)).build()) }
    }

    suspend fun savePrefs(update: PlaybackPrefsUpdate): PlaybackPrefs {
        val body = json.encodeToString(update).toRequestBody(jsonType)
        return json.decodeFromString(PlaybackPrefsResponse.serializer(), call(request("/api/playback/prefs").post(body).build())).prefs
    }

    /** Downloads [kb] kilobytes of random data from the computer and returns the speed in kbps. */
    suspend fun speedTestKbps(kb: Int = 1024): Int = withContext(Dispatchers.IO) {
        val req = request("/api/playback/speedtest${UrlUtils.query("kb" to kb.toString())}").get().build()
        val started = System.nanoTime()
        var bytes = 0L
        http.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw ApiException("Speed test failed (${r.code})", r.code)
            val source = r.body?.byteStream() ?: return@use
            val buf = ByteArray(32 * 1024)
            while (true) {
                val n = source.read(buf)
                if (n < 0) break
                bytes += n
            }
        }
        AutoQuality.kbps(bytes, (System.nanoTime() - started) / 1_000_000)
    }

    suspend fun searchOnline(kind: String, id: String, lang: String?): OnlineSearchResponse {
        val qs = UrlUtils.query("kind" to kind, "id" to id, "lang" to lang)
        return json.decodeFromString(OnlineSearchResponse.serializer(), call(request("/api/subtitles/online$qs").get().build()))
    }

    suspend fun downloadOnline(req: OnlineDownloadRequest): OnlineDownloadResponse {
        val body = json.encodeToString(req).toRequestBody(jsonType)
        return json.decodeFromString(OnlineDownloadResponse.serializer(), call(request("/api/subtitles/online/download").post(body).build()))
    }
}
