package com.beeboentertainment.movie.tripshare

import kotlinx.serialization.Serializable

/*
 * Sharing a finished trip: what the person chooses, and what the home computer says back.
 *
 * Everything in this package talks only to the person's OWN computer (the address they already signed
 * in to). Beebo hosts no trip media. Nothing here has a web address of its own; see TripSharePrivacyGuardTest.
 */

/** How long a link works. The sender chooses; the computer's owner may cap it lower. */
enum class ShareExpiry(val label: String, val hours: Int) {
    DAY("1 day", 24),
    TWO_DAYS("2 days", 48),
    WEEK("7 days", 7 * 24),
    MONTH("30 days", 30 * 24),
    QUARTER("90 days", 90 * 24);

    companion object {
        /** A link with no song lasts a month unless changed. */
        val DEFAULT = MONTH

        /**
         * A link that plays a song starts at two days, because the song is a copy of something the
         * sender may not be free to pass around, so the shorter window is the safer starting point.
         * It is only a starting point: the sender can still pick any length.
         */
        val DEFAULT_WITH_SONG = TWO_DAYS

        fun fromHours(hours: Int): ShareExpiry = entries.minByOrNull { kotlin.math.abs(it.hours - hours) } ?: DEFAULT
    }
}

/**
 * Where the shared trip lives. [OWN_PC] is the only one that exists.
 *
 * [BEEBO_HOSTED] is a deliberately DISABLED stub, kept so the screen can show that the choice exists
 * and is off. It must stay unavailable until a lawyer has signed off (hosting other people's family
 * media makes Beebo a controller of it: takedown, child-safety and privacy duties). Nothing in the app
 * sends trip media to a Beebo server, and TripSharePrivacyGuardTest fails if that ever changes.
 */
enum class ShareHosting(val label: String, val available: Boolean, val note: String) {
    OWN_PC(
        "My own computer",
        true,
        "A private link served by your Beebo computer. Your photos go from this phone to your computer and nowhere else. " +
            "The link stops working when the computer is off.",
    ),
    BEEBO_HOSTED(
        "Beebo-hosted link",
        false,
        "Not available. Beebo does not store or serve your trip photos, so a link works only while your own computer is on.",
    ),
}

/** What the sender picked for one link. Location and song are OFF unless switched on. */
data class ShareOptions(
    val includeLocation: Boolean = false,
    val includeSong: Boolean = false,
    val expiry: ShareExpiry = ShareExpiry.DEFAULT,
    /** Only meaningful with a song: "I have the right to share this recording with the people I send this to." */
    val rightsAck: Boolean = false,
    /** Guest names the sender ticked to show by name. Everyone else reads "a friend". */
    val shownNames: Set<String> = emptySet(),
    val includeOutsideMedia: Boolean = false,
) {
    /** Whether the person has done everything the options need before a link can be made. */
    fun problem(hasSong: Boolean): String? = when {
        includeSong && !hasSong -> "Choose the song file, or switch \"Add a song\" off."
        includeSong && !rightsAck -> "Tick the box to confirm you have the right to share this song."
        else -> null
    }

    /** Switching the song on or off moves the length to that mode's starting point, only if the sender had not changed it. */
    fun withSong(on: Boolean): ShareOptions {
        val untouched = expiry == (if (includeSong) ShareExpiry.DEFAULT_WITH_SONG else ShareExpiry.DEFAULT)
        return copy(
            includeSong = on,
            rightsAck = if (on) rightsAck else false,
            expiry = if (untouched) (if (on) ShareExpiry.DEFAULT_WITH_SONG else ShareExpiry.DEFAULT) else expiry,
        )
    }
}

/* ------------------------------ the computer's answers (wire shapes) ------------------------------ */

@Serializable
data class RemoteSettings(
    val enabled: Boolean = true,
    val maxStorageBytes: Long = 10L * 1024 * 1024 * 1024,
    val maxPhotoBytes: Long = 25L * 1024 * 1024,
    val maxVideoBytes: Long = 500L * 1024 * 1024,
    val maxSongBytes: Long = 40L * 1024 * 1024,
    val defaultExpiryHours: Int = 720,
    val maxExpiryHours: Int = 2160,
    val maxLiveShares: Int = 50,
    val maxMediaPerTrip: Int = 400,
)

@Serializable
data class RemoteUsage(val used: Long = 0, val incoming: Long = 0, val cap: Long = 0) {
    val free: Long get() = (cap - used - incoming).coerceAtLeast(0L)
}

@Serializable
data class ServerStatus(
    val ok: Boolean = false,
    val owner: Boolean = false,
    val settings: RemoteSettings = RemoteSettings(),
    val usage: RemoteUsage = RemoteUsage(),
    val linkBase: String = "",
    /** false when the computer's address only works on the home network. */
    val reachableAnywhere: Boolean = false,
    val chunkSize: Int = 512 * 1024,
)

@Serializable
data class RemoteOptions(val includeLocation: Boolean = false, val includeSong: Boolean = false, val viewOnly: Boolean = true)

@Serializable
data class RemoteShare(
    val id: String,
    val tripId: String = "",
    val title: String = "",
    /** "live", "expired" or "revoked". */
    val status: String = "live",
    val createdAt: Long = 0,
    val expiresAt: Long = 0,
    val revokedAt: Long? = null,
    val options: RemoteOptions = RemoteOptions(),
    val views: Int = 0,
    val lastViewedAt: Long? = null,
    val mediaCount: Int = 0,
) {
    val live: Boolean get() = status == "live"
}

@Serializable
data class SimpleAnswer(val ok: Boolean = false, val error: String? = null)

@Serializable
data class SharesAnswer(val ok: Boolean = false, val shares: List<RemoteShare> = emptyList(), val error: String? = null)

@Serializable
data class CreatedShare(
    val ok: Boolean = false,
    val token: String = "",
    val path: String = "",
    val url: String = "",
    val reachableAnywhere: Boolean = false,
    val share: RemoteShare? = null,
    val error: String? = null,
    val missing: List<String> = emptyList(),
)

/** A link the person made, kept on this phone (encrypted) so it can be shown or sent again. */
@Serializable
data class SavedLink(
    val shareId: String,
    val tripId: String,
    val title: String,
    val url: String,
    val createdAt: Long,
    val expiresAt: Long,
    val includeLocation: Boolean = false,
    val includeSong: Boolean = false,
    val reachableAnywhere: Boolean = false,
)

/** Numbers every screen and the upload planner share. Photos are redrawn smaller before they leave the phone. */
object ShareDefaults {
    const val PHOTO_MAX_EDGE = 1600
    const val PHOTO_QUALITY = 82
    /** A cap on what one link carries, in step with the computer's own per-trip cap. */
    const val MAX_MEDIA = 300
    /** Kept in step with the page: a caption is one short line. */
    const val CAPTION_MAX = 200
}
