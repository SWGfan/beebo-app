package com.beeboentertainment.movie.data

import kotlinx.serialization.Serializable

/*
 * Parental controls, profile switching and library sharing: the shapes of the home server's
 * parental, profiles, share info and admin parental/shares routes (electron/streamServer.js).
 * Every field has a default, like the rest of the contract.
 */

@Serializable
data class Bedtime(val start: String = "", val end: String = "")

@Serializable
data class TitleRef(val kind: String = "movie", val tmdbId: Int? = null, val id: String? = null, val title: String? = null)

@Serializable
data class ParentalPolicy(
    val enabled: Boolean = false,
    val preset: String = "off",
    val ratingSystem: String = "US",
    val movieMax: String? = null,
    val tvMax: String? = null,
    val blockUnrated: Boolean = false,
    val blockedGenres: List<Int> = emptyList(),
    val blockedTitles: List<TitleRef> = emptyList(),
    val blockedCollections: List<Int> = emptyList(),
    val allowListOnly: Boolean = false,
    val allowedTitles: List<TitleRef> = emptyList(),
    val allowedCollections: List<Int> = emptyList(),
    val dailyLimitMinutes: Int? = null,
    val bedtime: Bedtime? = null,
)

@Serializable
data class ParentalPreset(val id: String = "", val label: String = "", val policy: ParentalPolicy = ParentalPolicy())

@Serializable
data class MovieRatings(val US: List<String> = emptyList(), val CA: List<String> = emptyList())

@Serializable
data class ParentalOptions(
    val presets: List<ParentalPreset> = emptyList(),
    val movieRatings: MovieRatings = MovieRatings(),
    val tvRatings: List<String> = emptyList(),
)

@Serializable
data class ParentalMember(
    val id: String = "",
    val name: String = "",
    val username: String = "",
    val isAdmin: Boolean = false,
    val policy: ParentalPolicy = ParentalPolicy(),
    val adult: Boolean = false,
    val viewingHistoryPrivate: Boolean = false,
)

@Serializable
data class AdminParentalResponse(
    val ok: Boolean = false,
    val options: ParentalOptions = ParentalOptions(),
    val pinSet: Boolean = false,
    val users: List<ParentalMember> = emptyList(),
    val error: String? = null,
)

@Serializable
data class AdminParentalSetRequest(
    val userId: String,
    val preset: String? = null,
    val extra: ParentalExtra? = null,
    val policy: ParentalPolicy? = null,
)

@Serializable
data class ParentalExtra(val dailyLimitMinutes: Int? = null, val bedtime: Bedtime? = null)

@Serializable
data class AdminParentalSetResponse(val ok: Boolean = false, val policy: ParentalPolicy? = null, val error: String? = null, val message: String? = null)

@Serializable
data class PinRequest(val pin: String? = null, val currentPin: String? = null, val clear: Boolean? = null, val unlock: String? = null)

@Serializable
data class PinResponse(val ok: Boolean = false, val pinSet: Boolean = false, val unlock: String? = null, val error: String? = null, val minutesRemaining: Int? = null)

@Serializable
data class ParentalStatusResponse(
    val ok: Boolean = false,
    val restricted: Boolean = false,
    val guest: Boolean = false,
    val pinSet: Boolean = false,
    val canWatchNow: Boolean = true,
    val reason: String? = null,
    val message: String? = null,
    val usedMinutesToday: Int = 0,
)

@Serializable
data class ProfilesResponse(val ok: Boolean = false, val current: String = "", val pinSet: Boolean = false, val profiles: List<User> = emptyList())

@Serializable
data class SwitchProfileRequest(val userId: String, val pin: String? = null)

/* ------------------------------- shares -------------------------------- */

@Serializable
data class ShareConsent(val accepted: Boolean = false, val termsVersion: String = "", val acceptedAt: Long = 0, val statement: String = "")

@Serializable
data class OwnerShare(
    val id: String = "",
    val guestEmail: String = "",
    val guestLabel: String = "",
    val status: String = "",
    val createdAt: Long = 0,
    val libraries: List<String> = emptyList(),
    val folders: List<String> = emptyList(),
    val expiresAt: Long? = null,
    val maxStreams: Int = 1,
    val downloads: Boolean = false,
    val parental: ParentalPolicy = ParentalPolicy(),
    val consent: ShareConsent = ShareConsent(),
    val inviteCode: String? = null,
    val emailed: Boolean = false,
)

@Serializable
data class AdminSharesResponse(
    val ok: Boolean = false,
    val termsVersion: String = "",
    val statement: String = "",
    val maxShares: Int = 20,
    val shares: List<OwnerShare> = emptyList(),
    val error: String? = null,
)

@Serializable
data class CreateShareRequest(
    val guestEmail: String,
    val guestLabel: String = "",
    val libraries: List<String>,
    val maxStreams: Int = 1,
    val downloads: Boolean = false,
    val expiresAt: Long? = null,
    val parentalPreset: String = "off",
    val consent: ShareConsent,
)

@Serializable
data class ShareActionResponse(val ok: Boolean = false, val share: OwnerShare? = null, val error: String? = null)

@Serializable
data class GuestShareInfo(
    val id: String = "",
    val ownerLabel: String = "",
    val libraries: List<String> = emptyList(),
    val expiresAt: Long? = null,
    val maxStreams: Int = 1,
    val downloads: Boolean = false,
    val restricted: Boolean = false,
)

@Serializable
data class ShareInfoResponse(val ok: Boolean = false, val share: GuestShareInfo? = null)
