package com.beeboentertainment.movie.tvpair

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/*
 * The phone's side: type the code a TV is showing, see which TV asked, approve or deny.
 * Same rules as TvPairing.kt: no Android types here.
 */

/** What the phone shows about the TV that asked, so the person can recognise it. */
data class TvRequest(
    val deviceName: String,
    val deviceModel: String,
    val requestedMinutesAgo: Int,
    val expiresInS: Int,
)

enum class LinkError {
    /** Unknown, expired or already used. The Worker says the same for all three. */
    INVALID_CODE,
    /** Too many wrong codes from this phone or account. */
    RATE_LIMITED,
    /** This phone holds no valid Beebo account sign-in. */
    UNAUTHORIZED,
    /** A guest or household-pass sign-in: not a person. */
    NOT_ALLOWED,
    /** The account has no Beebo home for the TV to connect to. */
    NO_HOME,
    PASSWORD_RESET,
    UNAVAILABLE,
    OFFLINE,
    SERVER,
}

sealed interface LinkResult<out T> {
    data class Ok<T>(val value: T) : LinkResult<T>
    data class Refused(val error: LinkError, val retryAfterS: Int = 0) : LinkResult<Nothing>
}

enum class TvDecision(val wire: String) { APPROVE("approve"), DENY("deny") }

object TvLinkParsing {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun obj(body: String): JsonObject? = runCatching { json.parseToJsonElement(body) as? JsonObject }.getOrNull()
    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.int(k: String): Int? = (this[k] as? JsonPrimitive)?.intOrNull

    private fun refusal(httpCode: Int, o: JsonObject?): LinkResult.Refused {
        val error = o?.str("error")
        return when {
            httpCode == 429 -> LinkResult.Refused(LinkError.RATE_LIMITED, (o?.int("retry_after") ?: 0).coerceIn(0, 3600))
            httpCode == 401 -> LinkResult.Refused(LinkError.UNAUTHORIZED)
            error == "not_allowed" -> LinkResult.Refused(LinkError.NOT_ALLOWED)
            error == "no_home" -> LinkResult.Refused(LinkError.NO_HOME)
            error == "password_reset_required" -> LinkResult.Refused(LinkError.PASSWORD_RESET)
            error == "invalid_code" -> LinkResult.Refused(LinkError.INVALID_CODE)
            httpCode == 404 -> LinkResult.Refused(LinkError.UNAVAILABLE)
            else -> LinkResult.Refused(LinkError.SERVER)
        }
    }

    private fun request(o: JsonObject) = TvRequest(
        deviceName = o.str("device_name")?.ifBlank { null } ?: "TV",
        deviceModel = o.str("device_model").orEmpty(),
        requestedMinutesAgo = (o.int("requested_minutes_ago") ?: 0).coerceAtLeast(0),
        expiresInS = (o.int("expires_in") ?: 0).coerceAtLeast(0),
    )

    /** Answer to POST /tvpair/lookup. */
    fun parseLookup(httpCode: Int, body: String): LinkResult<TvRequest> {
        val o = obj(body)
        if (httpCode == 200 && o != null && o.str("device_name") != null) return LinkResult.Ok(request(o))
        return refusal(httpCode, o)
    }

    /** Answer to POST /tvpair/approve with a decision. */
    fun parseDecision(httpCode: Int, body: String, decision: TvDecision): LinkResult<TvRequest> {
        val o = obj(body)
        if (httpCode == 200 && o != null && o.str("status") == (if (decision == TvDecision.APPROVE) "approved" else "denied")) {
            return LinkResult.Ok(request(o))
        }
        return refusal(httpCode, o)
    }
}

object TvLinkMessages {
    fun forError(error: LinkError, retryAfterS: Int = 0): String = when (error) {
        LinkError.INVALID_CODE -> "That code isn't right, or it has run out. Check the code on your TV. A new one appears every few minutes."
        LinkError.RATE_LIMITED -> {
            val m = ((retryAfterS + 59) / 60).coerceAtLeast(1)
            "Too many tries. Wait $m minute${if (m == 1) "" else "s"} and try again."
        }
        LinkError.UNAUTHORIZED -> "This phone isn't signed in to your Beebo account right now. Sign in again, then try once more."
        LinkError.NOT_ALLOWED -> "This sign-in can't link a TV. Sign in with your own Beebo account."
        LinkError.NO_HOME -> "This account doesn't have a Beebo home yet, so there is nothing for a TV to connect to."
        LinkError.PASSWORD_RESET -> "This account needs a new password first."
        LinkError.UNAVAILABLE -> "Linking a TV isn't available yet."
        LinkError.OFFLINE -> "Couldn't reach Beebo. Check your connection and try again."
        LinkError.SERVER -> "Beebo didn't answer properly. Try again in a moment."
    }

    /** "3 minutes ago", coarse on purpose: enough to know it is the TV just switched on. */
    fun ago(minutes: Int): String = when {
        minutes <= 0 -> "just now"
        minutes == 1 -> "1 minute ago"
        else -> "$minutes minutes ago"
    }
}

/** The phone side of the protocol. */
interface TvLinkService {
    suspend fun lookup(token: String, userCode: String): LinkResult<TvRequest>
    suspend fun decide(token: String, userCode: String, decision: TvDecision): LinkResult<TvRequest>
}

/**
 * A code arriving from outside the screen (the beebo://tv-link deep link). Held until the signed-in
 * app is showing, then consumed by the Link a TV screen.
 */
object TvLinkRequests {
    private val _pending = MutableStateFlow<String?>(null)
    val pending: StateFlow<String?> = _pending.asStateFlow()

    /** [dataString] is the intent's data. Returns whether it was a link to this screen. */
    fun offer(dataString: String?): Boolean {
        val s = dataString?.trim().orEmpty()
        if (!s.startsWith(SCHEME_PREFIX, ignoreCase = true)) return false
        _pending.value = TvPairCodes.fromLinkOrText(s) ?: ""
        return true
    }

    fun consume() { _pending.value = null }

    const val SCHEME_PREFIX = "beebo://tv-link"
}
