package com.beeboentertainment.movie.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * What a signed-in profile may see in the app, from what the home server says about it
 * (/api/me: `restricted` = parental controls on, `guest` = someone from another household using
 * a shared library). The server enforces all of this itself; the app only avoids showing doors
 * that won't open. Free of Android so it can be unit tested.
 */
data class ProfileLimits(
    val showOwnerTools: Boolean,
    val showSettings: Boolean,
    val showTrailers: Boolean,
    val showRequests: Boolean,
    val showSearchOnline: Boolean,
    val showRelay: Boolean,
    val showSpaceSaver: Boolean,
) {
    companion object {
        fun of(isAdmin: Boolean, restricted: Boolean, guest: Boolean): ProfileLimits {
            val limited = restricted || guest
            return ProfileLimits(
                showOwnerTools = isAdmin && !limited,
                showSettings = !limited,
                showTrailers = !limited,
                showRequests = !limited,
                showSearchOnline = !limited,
                showRelay = !limited,
                showSpaceSaver = !limited,
            )
        }
    }
}

/** A library someone in another household shared with this person. Not a secret. */
@Serializable
data class SharedLibrary(
    val name: String,
    val ownerLabel: String = "",
    val email: String = "",
    val shareId: String = "",
) {
    val title: String get() = ownerLabel.ifBlank { "$name.beebo.tv" }
}

object SharedLibraries {
    private val json = Json { ignoreUnknownKeys = true }
    private val NAME = Regex("^[a-z0-9]{3,30}$")

    fun decode(text: String?): List<SharedLibrary> =
        runCatching { json.decodeFromString(ListSerializer(SharedLibrary.serializer()), text ?: "[]") }
            .getOrDefault(emptyList())
            .filter { NAME.matches(it.name) }

    fun encode(list: List<SharedLibrary>): String = json.encodeToString(ListSerializer(SharedLibrary.serializer()), list)

    /** Adds or refreshes one library (same house name), newest first, at most 20. */
    fun upsert(list: List<SharedLibrary>, lib: SharedLibrary): List<SharedLibrary> =
        (listOf(lib) + list.filterNot { it.name == lib.name }).take(20)

    fun remove(list: List<SharedLibrary>, name: String): List<SharedLibrary> = list.filterNot { it.name == name }

    /** The whole list as beebo.tv reports it for this account, keeping nothing it no longer lists. */
    fun replaceFromAccount(list: List<SharedLibrary>, fromServer: List<SharedLibrary>, email: String): List<SharedLibrary> =
        fromServer + list.filter { it.email.isNotBlank() && !it.email.equals(email, ignoreCase = true) }
}

/** Invite codes are 8 characters, shown as ABCD-EFGH; people type them any old way. */
object InviteCode {
    private const val ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

    fun normalize(input: String): String? {
        val s = input.uppercase().filter { it.isLetterOrDigit() }
        if (s.length != 8 || s.any { it !in ALPHABET }) return null
        return s.substring(0, 4) + "-" + s.substring(4)
    }
}

/** The owner PIN is 4 to 8 digits. */
object OwnerPin {
    fun valid(pin: String): Boolean = pin.length in 4..8 && pin.all { it in '0'..'9' }
}

/** Plain-language summary of a profile's limits, for the admin list. */
object ParentalSummary {
    fun of(
        enabled: Boolean,
        movieMax: String?,
        tvMax: String?,
        blockUnrated: Boolean,
        allowListOnly: Boolean,
        dailyLimitMinutes: Int?,
        bedtimeStart: String?,
        bedtimeEnd: String?,
    ): String {
        if (!enabled) return "Off"
        val parts = mutableListOf<String>()
        movieMax?.let { parts += "Films up to $it" }
        tvMax?.let { parts += "TV up to $it" }
        if (blockUnrated) parts += "unrated hidden"
        if (allowListOnly) parts += "allowed titles only"
        dailyLimitMinutes?.let { parts += "daily limit $it min" }
        if (bedtimeStart != null && bedtimeEnd != null) parts += "no watching $bedtimeStart-$bedtimeEnd"
        return parts.joinToString(", ").ifBlank { "On" }
    }

    private val HHMM = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")
    fun validTime(s: String): Boolean = HHMM.matches(s)
}

/** Reasons a person can give for "Report a problem" with a shared library (worker/shares.js). */
enum class ShareReportReason(val code: String, val label: String) {
    PIRACY("piracy", "It looks like pirated or unlicensed content"),
    UNWANTED("unwanted", "I didn't ask for this invite"),
    ABUSE("abuse", "Abusive or harmful content"),
    OTHER("other", "Something else"),
}
