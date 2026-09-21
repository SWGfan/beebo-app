package com.beeboentertainment.movie.data

import kotlinx.serialization.Serializable

@Serializable
data class ViewingPrivacyResponse(
    val ok: Boolean = false,
    val adult: Boolean = false,
    val enabled: Boolean = false,
    val eligible: Boolean = false,
    val hasPassword: Boolean = false,
    val message: String = "",
    val error: String? = null,
    val token: String? = null,
    val user: User? = null,
)

@Serializable
data class ViewingPrivacyRequest(val enabled: Boolean, val password: String)

@Serializable
data class AdultProfileRequest(val userId: String, val adult: Boolean)

@Serializable
data class AdultProfileResponse(
    val ok: Boolean = false,
    val adult: Boolean = false,
    val error: String? = null,
    val message: String = "",
)
