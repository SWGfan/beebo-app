package com.beeboentertainment.auto.hub

import kotlinx.serialization.Serializable

/*
 * Models for the coordination hub's `/api/v1/…` contract (JSON over HTTPS).
 *
 * Two layers on purpose:
 *
 *  - The @Serializable *Dto types mirror the wire JSON one field at a time, with
 *    nullable/defaulted fields so the hub can grow its payloads without breaking
 *    an installed app (the Json parser is configured with ignoreUnknownKeys, the
 *    same as ApiClient's).
 *  - HubSession and PcInfo are the small, non-null shapes the rest of the app
 *    actually consumes. HubClient maps the DTOs onto these.
 */

// ------------------------------------------------------------------- public API

/** The result of a successful signup/login. [token] is a JWT — send it back as
 *  `Authorization: Bearer <token>` on later calls. */
data class HubSession(
    val token: String,
    val accountId: String,
    val email: String,
    val tier: String,
)

/**
 * Where the hub says the user's home PC is, flattened for the caller.
 *
 * [connectVia] is `"direct"` when [baseUrl] can be used straight away, or
 * `"signal"` when the PC is only reachable through a WebRTC relay — in which
 * case the app opens a peer-to-peer link via
 * [com.beeboentertainment.auto.hub.HubAuth.startRemoteSession] instead of using
 * [baseUrl]. See [HubClient.resolveAndApply] and WEBRTC-STAGE2.md.
 */
data class PcInfo(
    val online: Boolean,
    val lastSeen: Long,
    val baseUrl: String?,
    val connectVia: String,
    val subscriptionActive: Boolean,
    val tier: String,
)

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
    val connectVia: String = "direct",
    val subscription: HubSubscriptionDto = HubSubscriptionDto(),
)

/** The `{"error":"…"}` shape every non-2xx response carries. */
@Serializable
data class HubErrorResponse(val error: String? = null)
