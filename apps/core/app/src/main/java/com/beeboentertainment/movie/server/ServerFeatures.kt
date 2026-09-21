package com.beeboentertainment.movie.server

import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.UnauthorizedException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The server features this app has screens for. Each is found out by asking the server, never
 * by comparing version numbers: an older computer answers 404 (or a page that is not JSON) and
 * the section stays hidden; a newer one answers and it appears. Nothing here is a purchase or a
 * setting the person changes - it only decides what to show.
 */
enum class ServerFeature(val probeMethod: String, val probePath: String) {
    LIVE_TV("GET", "/api/livetv/status"),
    AUDIOBOOKS("GET", "/api/audiobooks/status"),
    PODCASTS("GET", "/api/podcasts/status"),
    RADIO("GET", "/api/radio/status"),
    ACCOUNT_SECURITY("GET", "/api/account/security/status"),

    /** Only a server with Watch together answers a clock ping (it is also the first sync sample). */
    WATCH_TOGETHER("POST", "/api/watch-together/ping"),
}

/** Why a feature is on or off, for the tests and for the one line of help a screen may show. */
enum class Availability(val visible: Boolean) {
    AVAILABLE(true),
    /** The computer does not know this feature: older version. */
    OLDER_SERVER(false),
    /** Live TV: no tuner is set up (or it is switched off). */
    NOT_SET_UP(false),
    /** This profile or a shared-library guest may not use it. */
    NOT_ALLOWED(false),
    /** Could not ask (offline). Keeps whatever was known; treated as hidden the first time. */
    UNKNOWN(false),
}

object FeatureProbe {

    /** Decide from the probe's HTTP status and body. Pure. */
    fun decide(feature: ServerFeature, status: Int, body: String?): Availability {
        val json: JsonObject? = try {
            if (body.isNullOrBlank()) null else ApiClient.JSON.parseToJsonElement(body).jsonObject
        } catch (_: Exception) {
            null
        }
        val failureCode = if (status in 200..299) "" else ServerErrors.parse(status, body).code
        when {
            status in 200..299 -> Unit
            status == 403 && (failureCode == "restricted_profile" || failureCode == "not_available_to_guests") -> return Availability.NOT_ALLOWED
            status == 403 -> return Availability.NOT_ALLOWED
            else -> return Availability.OLDER_SERVER
        }
        // A 2xx that is not the Beebo JSON shape is a web page or another program answering.
        if (json == null || json["ok"]?.jsonPrimitive?.booleanOrNull != true) return Availability.OLDER_SERVER
        return when (feature) {
            ServerFeature.LIVE_TV -> {
                val enabled = json["enabled"]?.jsonPrimitive?.booleanOrNull ?: false
                val channels = json["channelCount"]?.jsonPrimitive?.intOrNull ?: 0
                if (enabled && channels > 0) Availability.AVAILABLE else Availability.NOT_SET_UP
            }
            ServerFeature.AUDIOBOOKS -> {
                val configured = json["configured"]?.jsonPrimitive?.booleanOrNull ?: false
                if (configured) Availability.AVAILABLE else Availability.NOT_SET_UP
            }
            ServerFeature.WATCH_TOGETHER -> if (json.containsKey("t1") && json.containsKey("t2")) Availability.AVAILABLE else Availability.OLDER_SERVER
            else -> Availability.AVAILABLE
        }
    }
}

/**
 * What is known about the connected server, asked at most once every few minutes and again after
 * a sign-in change. A feature that could not be asked about (offline) keeps its last answer.
 */
object ServerFeatures {

    data class Snapshot(val byFeature: Map<ServerFeature, Availability> = emptyMap(), val checkedAtMs: Long = 0L) {
        fun has(f: ServerFeature): Boolean = byFeature[f]?.visible == true
    }

    private const val TTL_MS = 5 * 60_000L

    private val _state = MutableStateFlow(Snapshot())
    val state: StateFlow<Snapshot> = _state.asStateFlow()
    @Volatile private var forKey: String = ""

    /** Forget everything, e.g. after signing out or switching profile. */
    fun clear() {
        forKey = ""
        _state.value = Snapshot()
    }

    fun isStale(now: Long): Boolean = now - _state.value.checkedAtMs > TTL_MS

    /**
     * Asks the server about every feature. [key] identifies who is asking (address + person): a
     * different key discards the old answers. Never throws; a 401 is passed to [onUnauthorized].
     */
    suspend fun refresh(client: ServerJson, key: String, now: Long = System.currentTimeMillis(), onUnauthorized: () -> Unit = {}) {
        if (key != forKey) { forKey = key; _state.value = Snapshot() }
        val previous = _state.value.byFeature
        val out = HashMap<ServerFeature, Availability>()
        for (f in ServerFeature.values()) {
            out[f] = try {
                val (status, body) = client.exchange(f.probeMethod, f.probePath, if (f.probeMethod == "POST") probeBody(now) else null)
                if (status == 401 && ServerErrors.parse(status, body).code.let { it.isEmpty() || it == "unauthorized" }) {
                    onUnauthorized()
                    return
                }
                FeatureProbe.decide(f, status, body)
            } catch (_: UnauthorizedException) {
                onUnauthorized()
                return
            } catch (_: ServerException) {
                previous[f] ?: Availability.UNKNOWN
            } catch (_: java.io.IOException) {
                previous[f] ?: Availability.UNKNOWN
            }
        }
        _state.value = Snapshot(out, now)
    }

    private fun probeBody(now: Long): String = "{\"t0\":$now}"
}
