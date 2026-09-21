package com.beeboentertainment.movie.hub

import kotlinx.serialization.Serializable

/*
 * Models for the coordination hub's /api/v1 contract (JSON over HTTPS).
 *
 * Two layers on purpose:
 *
 *  - The @Serializable Dto types mirror the wire JSON one field at a time, with
 *    nullable/defaulted fields so the hub can grow its payloads without breaking
 *    an installed app (the Json parser is configured with ignoreUnknownKeys, the
 *    same as ApiClient's).
 *  - HubSession and PcInfo are the small, non-null shapes the rest of the app
 *    actually consumes. HubClient maps the DTOs onto these.
 */

// ------------------------------------------------------------------- public API

/**
 * The result of a successful signup/login. [token] is a JWT — send it back as
 * `Authorization: Bearer <token>` on later calls.
 */
data class HubSession(
    val token: String,
    val accountId: String,
    val email: String,
    val tier: String,
)

/**
 * Where the hub says the user's home server is, flattened for the caller.
 *
 * [connectVia] is "direct" when [baseUrl] can be used straight away, or "signal"
 * when the server is only reachable through a relay — in which case the app has
 * no directly usable address to write and [HubClient.resolveAndApply] answers
 * [ServerResolution.RelayOnly]. Relay/WebRTC handling is out of scope here.
 */
data class PcInfo(
    val online: Boolean,
    val lastSeen: Long,
    val baseUrl: String?,
    val connectVia: String,
    val subscriptionActive: Boolean,
    val tier: String,
    /**
     * Every address the PC advertised, hub's best guess first. The hub can only
     * guess which one a given phone can actually reach, and a stale entry at the
     * front (an old dynamic-DNS name that no longer resolves) used to dead-end
     * sign-in completely. Empty when talking to an older hub.
     */
    val baseUrls: List<String> = emptyList(),
)

/**
 * What [HubClient.resolveAndApply] managed to do.
 *
 * This was a Boolean, which could not tell "your PC is switched off" apart from
 * "your PC is on, but this phone cannot reach any of the addresses it
 * advertises". Those want different sentences on screen, because only one of
 * them is fixed by walking over to the PC, so each case carries its own
 * [message] - written for whoever is holding the phone, not for a developer.
 *
 * The rule the whole type exists to enforce: [Applied] is the ONLY outcome that
 * writes [com.beeboentertainment.movie.data.SessionStore.baseUrl]. Every other
 * one leaves the saved address exactly as it found it, and reports it back as
 * [keptBaseUrl].
 */
sealed class ServerResolution {

    /** The address the app is pointed at now this call has finished. */
    abstract val keptBaseUrl: String?

    /** A sentence worth putting on screen. Plain language on purpose. */
    abstract val message: String

    /**
     * A candidate answered as a real Beebo server and is now the app's address.
     * The only case in which anything was written.
     */
    data class Applied(val baseUrl: String) : ServerResolution() {
        override val keptBaseUrl: String get() = baseUrl
        override val message: String get() = "Connected to your home server."
    }

    /** No hub token stored, so nothing was attempted and nothing was changed. */
    data class NotSignedIn(override val keptBaseUrl: String?) : ServerResolution() {
        override val message: String
            get() = "Sign in to your Beebo hub account first."
    }

    /** The hub knows this account's PC, but says it is not running just now. */
    data class Offline(override val keptBaseUrl: String?) : ServerResolution() {
        override val message: String
            get() = "Your home PC looks switched off right now. Start Beebo on it and try again."
    }

    /** On, but only reachable through the relay, which this app cannot use yet. */
    data class RelayOnly(override val keptBaseUrl: String?) : ServerResolution() {
        override val message: String
            get() = "Your home PC is on, but it can't be reached from outside your house yet."
    }

    /** On and direct, yet the hub named no address at all to try. */
    data class NoAddresses(override val keptBaseUrl: String?) : ServerResolution() {
        override val message: String
            get() = "Your home PC is on, but it hasn't told the hub which address to use."
    }

    /**
     * The hub named addresses, every one was probed, and none answered.
     *
     * [tried] keeps them in probe order so the message can name the one the hub
     * itself preferred. That concrete "couldn't reach <address>" is exactly what
     * the old code was saving a dead address to the settings to achieve; carried
     * in the result instead, it costs nothing.
     */
    data class NoneReachable(
        val tried: List<String>,
        override val keptBaseUrl: String?,
    ) : ServerResolution() {
        override val message: String
            get() = buildString {
                append("Your home PC is on, but this phone couldn't reach it")
                tried.firstOrNull()?.let { append(" at ").append(it) }
                append(".")
                // The hub only knows addresses on the house's own network, so away from
                // home none of them can ever answer. Saying so, and pointing at the sign-in
                // that does work, beats leaving someone staring at a dead address (2026-09-17).
                append(" Those are addresses on your home network, so they only work there. ")
                append("Away from home, sign in at the top with your home's name or the email of whoever pays for Beebo.")
                if (keptBaseUrl != null) append(" Your saved address hasn't been changed.")
            }
    }
}

// ------------------------------------------------------------------- wire (DTO)

@Serializable
data class HubAuthRequest(val email: String, val password: String)

@Serializable
data class HubAccountDto(
    val id: String = "",
    val email: String = "",
    val tier: String = "",
)

@Serializable
data class HubAuthResponse(
    val token: String? = null,
    val account: HubAccountDto? = null,
)

@Serializable
data class HubSubscriptionDto(
    val active: Boolean = false,
    val tier: String = "",
)

@Serializable
data class HubPcResponse(
    val online: Boolean = false,
    val lastSeen: Long = 0L,
    val baseUrl: String? = null,
    /** Added later than [baseUrl]; absent when the hub predates the change. */
    val baseUrls: List<String> = emptyList(),
    val connectVia: String = "direct",
    val subscription: HubSubscriptionDto = HubSubscriptionDto(),
)

/** The {"error":"..."} shape every non-2xx response carries. */
@Serializable
data class HubErrorResponse(val error: String? = null)

// ------------------------------------------------------------------- car party

/** Result of starting a car party: the short code to read out to passengers. */
data class PartyStart(val code: String, val hostName: String?)

@Serializable
data class HubPartyStartRequest(val name: String? = null)

@Serializable
data class HubPartyStartResponse(
    val code: String? = null,
    val hostName: String? = null,
)
