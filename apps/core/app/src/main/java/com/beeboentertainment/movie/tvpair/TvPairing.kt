package com.beeboentertainment.movie.tvpair

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/*
 * Signing a TV in from a phone (worker/tvPair.js, RFC 8628 style). Everything here is plain Kotlin
 * with no Android types, so the code rules, the response parsing and the TV's poll loop can be
 * asserted on the JVM. The HTTP calls are in TvPairHttp; the screens are in ui/screens.
 */

object TvPairing {
    /** Only a TV shows the "sign in with your phone" code; a phone is the one that approves it. */
    fun offersPhoneSignIn(isTv: Boolean): Boolean = isTv

    /** "Link a TV" belongs on a phone or tablet: a TV has no second screen to approve from. */
    fun offersLinkATv(isTv: Boolean): Boolean = !isTv

    /**
     * What the phone shows for the TV that asked. Prefer the name the person gave the TV in its
     * own settings; otherwise the make and model, without repeating the make inside the model.
     */
    fun deviceLabel(userSetName: String?, manufacturer: String?, model: String?): String {
        userSetName?.trim()?.takeIf { it.isNotEmpty() }?.let { return it.take(40) }
        val make = manufacturer?.trim().orEmpty()
        val mdl = model?.trim().orEmpty()
        val joined = when {
            make.isEmpty() -> mdl
            mdl.isEmpty() -> make
            mdl.startsWith(make, ignoreCase = true) -> mdl
            else -> "$make $mdl"
        }
        return joined.ifEmpty { "TV" }.take(40)
    }
}

/** The 8-symbol code the TV shows and the phone types. Mirrors normalizeUserCode in tvPair.js. */
object TvPairCodes {
    /** No 0, O, 1 or I. */
    const val ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    const val LENGTH = 8

    /** Case, hyphens and spaces don't matter. Null when it isn't a complete code. */
    fun normalize(input: String?): String? {
        val s = input.orEmpty().uppercase().filter { !it.isWhitespace() && it != '-' && it != '_' && it != '.' }
        return s.takeIf { it.length == LENGTH && it.all { c -> c in ALPHABET } }
    }

    fun format(code: String): String = if (code.length == LENGTH) code.substring(0, 4) + "-" + code.substring(4) else code

    /**
     * The text box as someone types: upper case, code symbols only, at most eight, a hyphen after
     * the fourth. A pasted link keeps just its code.
     */
    fun formatTyped(raw: String): String {
        if (raw.contains("code=", ignoreCase = true)) fromLinkOrText(raw)?.let { return format(it) }
        val symbols = raw.uppercase().filter { it in ALPHABET }.take(LENGTH)
        return if (symbols.length > 4) symbols.substring(0, 4) + "-" + symbols.substring(4) else symbols
    }

    /** A code out of `https://beebo.tv/tv?code=ABCD-EFGH`, `beebo://tv-link?code=...` or the bare code. */
    fun fromLinkOrText(text: String?): String? {
        val t = text?.trim().orEmpty()
        if (t.isEmpty()) return null
        val at = t.indexOf("code=", ignoreCase = true)
        if (at < 0) return normalize(t)
        val value = t.substring(at + 5).takeWhile { it != '&' && it != '#' && !it.isWhitespace() }
        return normalize(runCatching { java.net.URLDecoder.decode(value, "UTF-8") }.getOrDefault(value))
    }
}

/* ------------------------------------------------------------------------------ results */

data class PairSession(
    val deviceCode: String,
    val userCode: String,
    val verificationUri: String,
    val verificationUriComplete: String,
    val expiresInS: Int,
    val intervalS: Int,
)

data class PairFailure(val kind: Kind, val retryAfterS: Int = 0) {
    enum class Kind {
        /** No network, DNS or TLS failure. */
        OFFLINE,
        /** 429: this address is being told to slow down. */
        RATE_LIMITED,
        /** 404: the service isn't switched on. */
        UNAVAILABLE,
        /** A 5xx. */
        SERVER,
        /** Anything else, including an answer that isn't what the protocol says. */
        BAD_RESPONSE,
    }
}

sealed interface StartResult {
    data class Started(val session: PairSession) : StartResult
    data class Failed(val failure: PairFailure) : StartResult
}

sealed interface PollResult {
    data class Pending(val intervalS: Int) : PollResult
    data class SlowDown(val intervalS: Int) : PollResult
    data class Approved(val name: String, val token: String, val expiresAtSec: Long) : PollResult
    /** [reason] is the Worker's error: access_denied, no_home, password_reset_required. */
    data class Denied(val reason: String) : PollResult
    data object Expired : PollResult
    data class Failed(val failure: PairFailure) : PollResult
}

/** The TV's side of the protocol. */
interface TvPairService {
    suspend fun start(deviceName: String, deviceModel: String): StartResult
    suspend fun poll(deviceCode: String): PollResult
}

/* ------------------------------------------------------------------------------ parsing */

object TvPairParsing {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun obj(body: String): JsonObject? = runCatching { json.parseToJsonElement(body) as? JsonObject }.getOrNull()
    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.int(k: String): Int? = (this[k] as? JsonPrimitive)?.intOrNull
    private fun JsonObject.long(k: String): Long? = (this[k] as? JsonPrimitive)?.longOrNull

    fun failureFor(httpCode: Int, body: JsonObject?): PairFailure = when {
        httpCode == 404 -> PairFailure(PairFailure.Kind.UNAVAILABLE)
        httpCode == 429 -> PairFailure(PairFailure.Kind.RATE_LIMITED, (body?.int("retry_after") ?: body?.int("interval") ?: 0).coerceIn(0, 3600))
        httpCode >= 500 -> PairFailure(PairFailure.Kind.SERVER)
        else -> PairFailure(PairFailure.Kind.BAD_RESPONSE)
    }

    fun parseStart(httpCode: Int, body: String): StartResult {
        val o = obj(body)
        if (httpCode != 200 || o == null) return StartResult.Failed(failureFor(httpCode, o))
        val device = o.str("device_code")
        val user = TvPairCodes.normalize(o.str("user_code"))
        if (device.isNullOrEmpty() || user == null) return StartResult.Failed(PairFailure(PairFailure.Kind.BAD_RESPONSE))
        val uri = o.str("verification_uri").orEmpty()
        return StartResult.Started(
            PairSession(
                deviceCode = device,
                userCode = user,
                verificationUri = uri,
                verificationUriComplete = o.str("verification_uri_complete") ?: (if (uri.isEmpty()) "" else uri + "?code=" + TvPairCodes.format(user)),
                expiresInS = (o.int("expires_in") ?: 600).coerceIn(30, 600),
                intervalS = TvPairController.clampInterval(o.int("interval") ?: 5),
            )
        )
    }

    fun parsePoll(httpCode: Int, body: String): PollResult {
        val o = obj(body)
        if (o == null) return PollResult.Failed(failureFor(httpCode, null))
        // 429 carries both "slow_down" (polling too fast) and "too_many_attempts" (locked out).
        return when (o.str("status")) {
            "pending" -> PollResult.Pending(o.int("interval") ?: 5)
            "slow_down" -> PollResult.SlowDown(o.int("interval") ?: 10)
            "expired" -> PollResult.Expired
            "denied" -> PollResult.Denied(o.str("error") ?: "access_denied")
            "approved" -> {
                val name = o.str("name")
                val token = o.str("token")
                if (name.isNullOrEmpty() || token.isNullOrEmpty()) PollResult.Failed(PairFailure(PairFailure.Kind.BAD_RESPONSE))
                else PollResult.Approved(name, token, o.long("expiresAt") ?: 0L)
            }
            else -> PollResult.Failed(failureFor(httpCode, o))
        }
    }
}

/* ------------------------------------------------------------------------------ TV poll loop */

sealed interface TvPairState {
    data object Starting : TvPairState

    /** [offline] is set while polls are failing: the code stays up, and a banner says it is retrying. */
    data class ShowCode(
        val userCode: String,
        val verificationUri: String,
        val verificationUriWithCode: String,
        val offline: Boolean = false,
    ) : TvPairState

    /** No code could be had yet; trying again in [retryInS] seconds. */
    data class Waiting(val failure: PairFailure, val retryInS: Int) : TvPairState
}

sealed interface TvPairOutcome {
    data class Approved(val name: String, val token: String, val expiresAtSec: Long) : TvPairOutcome
    data class Denied(val reason: String) : TvPairOutcome
    /** The service is not switched on: fall back to typing. */
    data object Unavailable : TvPairOutcome
}

/**
 * Runs the TV side: ask for a code, show it, poll at the server's interval (adding time when told
 * to slow down), start over with a fresh code when it expires, ride out network trouble without
 * giving up, and stop when the phone answers. Cancel the coroutine to stop.
 */
class TvPairController(
    private val service: TvPairService,
    private val deviceName: String,
    private val deviceModel: String,
    private val nowMs: () -> Long,
) {
    private val _state = MutableStateFlow<TvPairState>(TvPairState.Starting)
    val state: StateFlow<TvPairState> = _state.asStateFlow()

    suspend fun run(): TvPairOutcome {
        var startFailures = 0
        while (true) {
            if (_state.value !is TvPairState.Waiting) _state.value = TvPairState.Starting
            when (val started = service.start(deviceName, deviceModel)) {
                is StartResult.Failed -> {
                    if (started.failure.kind == PairFailure.Kind.UNAVAILABLE) return TvPairOutcome.Unavailable
                    startFailures++
                    val wait = retryDelayS(started.failure, startFailures)
                    _state.value = TvPairState.Waiting(started.failure, wait)
                    delay(wait * 1000L)
                }
                is StartResult.Started -> {
                    startFailures = 0
                    pollSession(started.session)?.let { return it }
                }
            }
        }
    }

    /** Null when the code ran out, which means "ask for a new one". */
    private suspend fun pollSession(s: PairSession): TvPairOutcome? {
        _state.value = TvPairState.ShowCode(TvPairCodes.format(s.userCode), s.verificationUri, s.verificationUriComplete)
        // A little past the session's life: an approval made in its last seconds is still collectable.
        val deadline = nowMs() + s.expiresInS * 1000L + GRACE_MS
        // What the server asked for, which only ever grows; backing off after a failure is separate.
        var base = clampInterval(s.intervalS)
        var wait = base
        var failures = 0
        while (true) {
            delay(wait * 1000L)
            if (nowMs() >= deadline) return null
            when (val r = service.poll(s.deviceCode)) {
                is PollResult.Pending -> { failures = 0; markOffline(false); base = maxOf(base, clampInterval(r.intervalS)); wait = base }
                is PollResult.SlowDown -> {
                    failures = 0; markOffline(false)
                    base = maxOf(base + 5, clampInterval(r.intervalS)).coerceAtMost(MAX_INTERVAL_S)
                    wait = base
                }
                is PollResult.Approved -> return TvPairOutcome.Approved(r.name, r.token, r.expiresAtSec)
                is PollResult.Denied -> return TvPairOutcome.Denied(r.reason)
                PollResult.Expired -> return null
                is PollResult.Failed -> when (r.failure.kind) {
                    PairFailure.Kind.UNAVAILABLE -> return TvPairOutcome.Unavailable
                    PairFailure.Kind.RATE_LIMITED -> wait = maxOf(base, r.failure.retryAfterS.coerceIn(1, 900))
                    else -> { failures++; markOffline(true); wait = backoffS(failures) }
                }
            }
        }
    }

    private fun markOffline(offline: Boolean) {
        val s = _state.value
        if (s is TvPairState.ShowCode && s.offline != offline) _state.value = s.copy(offline = offline)
    }

    companion object {
        const val MIN_INTERVAL_S = 2
        const val MAX_INTERVAL_S = 30
        private const val GRACE_MS = 15_000L

        fun clampInterval(seconds: Int): Int = seconds.coerceIn(MIN_INTERVAL_S, MAX_INTERVAL_S)

        /** 5, 10, 20, then 30 seconds. */
        fun backoffS(failures: Int): Int = (5 shl (failures - 1).coerceIn(0, 3)).coerceAtMost(MAX_INTERVAL_S)

        /** A start that failed: the server's own Retry-After when it gave one, otherwise back off. */
        fun retryDelayS(failure: PairFailure, failures: Int): Int =
            if (failure.kind == PairFailure.Kind.RATE_LIMITED && failure.retryAfterS > 0) failure.retryAfterS.coerceIn(5, 900)
            else backoffS(failures)
    }
}

/* ------------------------------------------------------------------------------ what the TV says */

object TvPairMessages {
    const val PRIMARY_ACTION = "Sign in with your phone"
    const val TYPE_INSTEAD = "Sign in with email and password instead"
    const val PHONE_INSTEAD = "Sign in with your phone instead"

    fun steps(hasWebsite: Boolean, address: String): String =
        if (hasWebsite) "On your phone, open Beebo, go to Settings, then Link a TV, and enter the code. Or scan the code with your camera, or go to $address."
        else "On your phone, open Beebo, go to Settings, then Link a TV, and enter the code."

    fun problem(failure: PairFailure, retryInS: Int): String = when (failure.kind) {
        PairFailure.Kind.OFFLINE -> "Can't reach Beebo. Check this TV's internet connection. Trying again in $retryInS seconds."
        PairFailure.Kind.RATE_LIMITED -> "Too many tries from this network. Trying again in ${minutes(retryInS)}."
        PairFailure.Kind.UNAVAILABLE -> "Phone sign-in isn't available yet."
        PairFailure.Kind.SERVER, PairFailure.Kind.BAD_RESPONSE -> "Beebo didn't answer properly. Trying again in $retryInS seconds."
    }

    const val OFFLINE_BANNER = "Can't reach Beebo right now. Trying again..."
    const val UNAVAILABLE = "Signing in with your phone isn't available yet. Use your email and password instead."

    fun denied(reason: String): String = when (reason) {
        "no_home" -> "That account doesn't have a Beebo home set up yet, so there is nothing for this TV to connect to."
        "password_reset_required" -> "That account needs a new password first. Reset it, then try again."
        else -> "Your phone said no. If that wasn't you, nothing was signed in."
    }

    private fun minutes(seconds: Int): String {
        val m = ((seconds + 59) / 60).coerceAtLeast(1)
        return "$m minute" + if (m == 1) "" else "s"
    }
}
